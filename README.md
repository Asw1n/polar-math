# polar-math

Pure calculations for canonical `polar-format` v1 tables and v2 polar sets. The package has no Signal K dependency.

The [version-2 API specification](docs/polar-v2-api-specification.md) records the
agreed design implemented in this source tree: polar-set support, auxiliary
queries and wave-adjusted targets. These changes are unreleased; no package
version is assigned here.

`Polar.fromTable(table)` validates and prepares an immutable polar table once. All query methods accept
their dynamic inputs explicitly and return `{ value, state }`. Measurements use SI units: m/s and radians.

```js
const { Polar } = require('polar-math')

const polar = Polar.fromTable(table)
const speed = polar.speedAt({ tws, twa, performanceFactor: 1.0 })
const vmg = polar.vmgAt({ tws, twa, performanceFactor: 1.0 })
const targets = polar.targetsAt({ tws, performanceFactor: 1.0 })
const range = polar.rangeAt({ tws })

// Each instance holds exactly ONE selected table, with shared root wave context.
const best = Polar.fromPolarSet(polarSet)
const sailplan = Polar.fromPolarSet(polarSet, sailplanId)
const heel = sailplan.heelAt({ tws, twa })
const reef = sailplan.reefAt({ tws, twa })
const flat = sailplan.flatAt({ tws, twa })
```

Both loaders use published `polar-format` (`^2.0.0`) schema and semantic validation.
Invalid documents, unsupported versions and unknown sailplan IDs throw descriptive
`TypeError`s. Omission selects `best`; no ID is reserved, and failed selection
never falls back. Preparation neither mutates nor retains mutable source data.
Storage, migration, resource selection and operational sailplan ownership are
outside this library.

`state` always includes `available`. For valid queries it also includes the TWS range state and, for
angle-dependent calls, the TWA range state. Invalid numeric input (including a `twa` outside `[-π, π]`)
returns `value: null` and `state.reason: 'invalid_input'`.

`state.tws` is one of:
- `in_range` — within the table's TWS axis
- `below_range` — below the lowest real TWS row (speed/targets retain the existing
  linear ramp from a synthetic zero-speed row at 0.0001 m/s, or half the first TWS
  if lower; below that synthetic row, clamp to zero). Auxiliary values clamp to
  their first real TWS row, without inventing a zero auxiliary value.
- `above_range` — above the highest TWS row (result is clamped to it)

`state.twa` (angle-dependent calls only) is one of:
- `in_range` — within the sailable TWA range
- `below_range` — below available angular data where no pinch extension is supported
- `pinching` — between the pinch boundary and the beat angle; a reduced positive speed is returned
- `in_irons` — below the pinch boundary; `speedAt`/`vmgAt` return `value: null`
- `extrapolated` — beyond the table's last real TWA point but within the modeled run extension
- `above_range` — beyond the modeled range; `speedAt`/`vmgAt` return `value: null`

The performance factor is deliberately a per-query input and defaults to `1.0`, meaning the polar's
unadjusted performance. Values below `1.0` scale the calculated speed and target values down.
It must be finite and nonnegative; zero is supported. It never scales auxiliary values.
Unavailable baseline or auxiliary queries return `available: false`, `reason: 'no_data'`;
usable wave fallbacks remain available. Target VMG is a nonnegative magnitude;
`vmgAt` is signed.

## Interpolation and extrapolation

Within a TWS row, a query angle that falls between two real points (measured axis columns, plus any
`derived.rows` beat/run target inserted into the same list) is interpolated using a **monotone cubic
Hermite spline (PCHIP)** — smooth (continuous slope) and passing exactly through the input and synthetic
curve points, but with
a built-in constraint that it can never overshoot or oscillate between two points the way a plain cubic
spline can. Between two TWS rows, results are still linearly interpolated (TWS rows are few and widely
spaced, and are never rendered as a continuous curve themselves, so the simpler method is preferred
there). Angles *outside* the real data span (below the beat angle, or beyond the last real point)
fall back to the modeled extrapolation described below.

Interior null speed cells are missing samples: PCHIP interpolates across them.
Edge nulls delimit coverage. **Numeric zero is a supplied sample in both loaders**,
not the old zero-as-missing sentinel. Existing v1 producers using zeros to mean
missing must remove those samples or explicitly migrate to nullable v2 data.
Entirely null rows without usable targets are skipped; an entirely unavailable
table returns `no_data`. Lone samples remain queryable only at their exact angle.
Between TWS rows, speed requires both rows at the requested angle, and `rangeAt`
reports their common interval (not an interpolation of incompatible bounds).
No common interval means `value: null`, `reason: 'no_data'`.
This is baseline model availability, not a safety limit, sail operating limit or
wave-model coverage.

### Beat-side (pinching)

Below the beat angle, speed is modeled down to a fixed 25° endpoint. A synthetic zero-speed point is
prepended at 25°, and the same PCHIP fit above interpolates through it like any other curve point. This
endpoint is part of the curve construction and is independent of the pinch cutoff. `rangeAt`'s reported
`minTwa` is the endpoint plus `PINCH_FACTOR` (currently `0.8`) of the angular distance from that endpoint
to the beat angle:

```text
minTwa = 25° + 0.8 × (beatAngle - 25°)
```

The cutoff never excludes a known real point: it is capped at the first real
angle if that angle is lower. A lone point does not create an extension.

Queries below this boundary are classified as `in_irons` and return `value: null`; the boundary does not
alter the PCHIP curve. The 25° endpoint is only added when a valid beat target exists and the row's first
point is above 25°.

### Run-side (gybe)

The deepest real angle in a row is rarely 180° (dead downwind), but the polar plot is mirrored
port/starboard at 180°, so a query (or a rendered curve) needs *something* defined all the way there.
Unlike the beat side, real sailing behaviour genuinely continues past the last known angle — so this side
does need an extrapolated model, in two steps, both operating on **VMG** (`speed × |cos(twa)|`) rather
than raw speed, because VMG — not speed — is the quantity that peaks at the run angle and is expected to
behave predictably beyond it:

1. **Mirror point.** The run angle is a peak: VMG rises up to it and falls beyond it. As a first
   extrapolated point, the model assumes the fall mirrors the rise — the VMG at
   `runAngle + d` is assumed equal to the VMG already measured at `runAngle - d`, where `d` is the
   distance back to the nearest real axis point below the run angle. This adds **at most one** synthetic
   point, and only when it would land beyond the last real point and at or before 180°; if real data
   already reaches (or the mirror would overshoot) 180°, no mirror point is added. This point also
   becomes part of the PCHIP fit above, like any other point.
2. **Taper to zero slope at 180°.** From the deepest known angle (the mirror point, or the last real
   point if no mirror was added), the VMG slope is assumed to decrease linearly to exactly zero at 180° —
   the point where the boat gybes and the polar mirrors onto itself, so VMG must be momentarily flat
   there. The starting slope for this taper is taken directly from the PCHIP tangent at that point
   (converted from `dSpeed/dTWA` to `dVMG/dTWA`), so the taper connects smoothly to the interior curve
   rather than starting from an independent estimate. Integrating that linear slope gives a quadratic VMG
   curve out to 180°, converted back to boat speed at query time. Two safety clamps apply: speed is never
   negative, and VMG is never allowed to increase past its value at the deepest known angle.

Both the mirror point and the taper are skipped if a row has no run target, too few points to establish a
slope, or is already complete out to 180°.

The 180-degree taper needs two points; the mirror additionally needs a real axis
point below the run angle.

### Opting out: `extrapolate: false`

Every query method accepts `extrapolate` (default `true`). Pass `extrapolate: false` to restrict results to
real data only — no beat-side 25° endpoint, no run-side mirror/taper. `rangeAt` then reports the TWA span
actually covered by measured axis columns and derived targets, and `speedAt`/`vmgAt` return `value: null`
(`state.twa: 'below_range'`/`'above_range'`) for anything outside it. Use this when extrapolated data
would be misleading for the caller's purpose (e.g. feeding a live performance calculation) rather than
just for rendering a continuous curve.

## Auxiliary quantities and targets

`heelAt`, `reefAt` and `flatAt` interpolate linearly in TWA, skip interior nulls,
preserve exact samples and never extrapolate angularly, even with `extrapolate: true`.
Both contributing TWS rows must provide the quantity; an exact TWS uses only that
row. Coverage is independent of speed and of other auxiliaries. Missing data is
`null`/`no_data`, not zero or one; out-of-coverage angles report `below_range` or
`above_range`. Heel is unsigned radians. Reef and flat are dimensionless VPP model
factors, not discrete reef indices or physical trim positions.

```js
polar.targetsAt({ tws }).value
// {
//   beat: { twa, speed, vmg, heel, reef, flat },
//   run: { twa, speed, vmg, heel, reef, flat },
//   maxSpeed: { twa, speed, heel, reef, flat }
// }
```

An unavailable target is `null`; each unknown auxiliary field is independently
`null`, without per-field status. Stored beat/run targets remain baseline curve
inputs, including when not reproducible from the grid. A supplied maximum-speed/
angle pair is retained too (and supplies a lone speed point if no other points
exist). Baseline beat/run VMG retains the existing two-decimal rounding.
At each stored TWS, supplied target auxiliaries take precedence over matrix
sampling at that target angle. Resolved target fields are then interpolated
between TWS rows only when both values exist. Maximum-speed auxiliaries are
sampled at its angle.

## Waves

```js
polar.waveFactorAt({
  significantWaveHeight: 2, // metres
  wavePeriod: 8,           // seconds
  waveAngle: Math.PI / 2   // bow-relative wave FROM direction, radians
})
polar.speedAt({
  tws, twa, performanceFactor: 0.9,
  seaState: { significantWaveHeight: 2, wavePeriod: 8, waveAngle: Math.PI / 2 }
})
polar.targetsAt({
  tws,
  tack: 'starboard',       // default; alternatively 'port'
  optimizationBudget: 20,  // default ZERO; budget applies to EACH target
  seaState: {
    significantWaveHeight: 2,
    wavePeriod: 8,
    waveDirectionRelativeToWind: Math.PI / 3
  }
})
```

`vmgAt` accepts the same bow-relative sea state as `speedAt`. Wave angles are
unsigned `[0, pi]`: head sea is zero, beam sea `pi/2`, following sea `pi`.
Targets instead require a signed wind-relative direction in `[-pi, pi]`,
clockwise from the true-wind **from** direction. At unsigned candidate TWA `a`
and wind-relative direction `d`, fold `d + a` on starboard or `d - a` on port
into `[0, pi]`. The physical sea state is the same on both tacks; results can
differ. Returned target TWA stays unsigned.

Supplied sea states must be complete: finite height >= 0, finite period > 0 and
finite in-range direction. This applies even at height zero or with no model.
Invalid input returns `null`/`invalid_input`, never baseline fallback.

Wave factors interpolate linearly in angle, then period within each independent
height grid, then height. Each contributing layer must cover the query; exact
height/period samples need no unused neighbours. Wave axes never clamp or
extrapolate. Zero factors and factors above one are supported.

`speed = baselineSpeed * waveFactor * performanceFactor`. Omitted sea state
uses baseline behavior. Valid missing-model or out-of-range conditions return
usable baseline fallback (including performance factor), never inventing
baseline availability. Auxiliary quantities are not wave-scaled.

Scalar speed, VMG and factor results add `state.waveCorrection`:

```js
{ applied: true, reason: null }
// Otherwise applied: false, reason: 'not_requested' | 'no_model' | 'out_of_range'
```

Supported factor one still counts as applied. `waveFactorAt` returns factor one
for `no_model`/`out_of_range`, but `null` for invalid input. Its TWS/TWA states
are null because those axes are not queried.

### Target effort and fallback

Zero budget keeps baseline angles/auxiliaries and corrects each target's speed
and VMG there. Positive budgets search baseline speed curves for corrected beat
VMG, run VMG magnitude and maximum speed separately. New angles sample baseline
auxiliaries there; unchanged baseline target angles retain their resolved
auxiliaries. Unsupported wave probes are skipped, never compared as uncorrected
candidates. If no supported candidate is found, only that target falls back.
Missing baseline targets stay null.

The deterministic search evaluates the baseline angle (if within its domain),
then domain endpoints, then interval midpoints in breadth-first order. Beat
uses the available range up to `pi/2`, run from `pi/2`, and maximum speed the
whole range. Multiple regions are explored, without assuming one local optimum.
Each distinct angle attempted, including unsupported probes, costs one
evaluation; repeated exact angles cost none. No search exceeds its individual
budget. Wave checks at zero-budget baseline targets do not count as search.
Equal scores keep the first candidate. Search converges only after all
intervals have width <= `1e-5` radians and their midpoints have been visited (or
floating-point subdivision is exhausted). Until then it reports budget
exhaustion. Results are **best found**, not a global-optimum guarantee; very
narrow supported regions can be missed with small budgets. There is no
assumption-based corrected-polar cache.

Targets add two per-target maps keyed `beat`, `run`, `maxSpeed`:

```js
state.waveCorrection.beat // { applied, reason }
state.optimization.beat   // { status, evaluations }
```

Optimization status is `not_requested` (zero budget), `not_applicable` (sea state
omitted, no model, or no supported candidate), `unavailable` (missing target or
baseline search domain), `budget_exhausted`, or `converged`. Missing targets take
precedence over zero-budget `not_requested`. Applied results can coexist with
fallbacks on other targets. Invalid queries and entirely missing baseline data
instead return the ordinary unavailable overall result.

## Verification and routing benchmark

Run `npm test` and `npm run benchmark` (Node >= 20). The benchmark prepares a
12-TWS x 31-TWA table, validates a v2 set with best plus four sailplans, and
queries 1,024 varying wind/sea states and alternating tacks. It warms each
operation and reports the median and range of five timed samples. Preparation
includes validation and immutable data preparation; queries reuse a prepared
instance, not cached sea-state results.

One Windows x64 / Node 24.19.0 run measured:

| Operation | Median microseconds/op |
| --- | ---: |
| Prepare v1 | 496.016 |
| Prepare v2, including whole-set validation | 797.866 |
| Baseline speed | 2.810 |
| Wave speed | 4.452 |
| Baseline targets | 3.821 |
| Wave targets, zero budget | 10.675 |
| Wave targets, budget 20 per target | 254.442 |
| Wave targets, budget 100 per target | 1510.506 |

These are synthetic routing-workload observations, including harness overhead,
not performance promises; rerun on deployment hardware and representative
documents. Timed budget-100 samples varied from 843.048 to 2174.765 microseconds/op
on this shared environment. Large budgets can be expensive in both CPU and temporary memory.
There is no release/dependency blocker: the dependency is published
`polar-format@2.0.0`, not a local link. The existing lockfile's transitive
`fast-uri` dependency produces a moderate npm audit finding; dependency
hardening beyond the required format upgrade is outside this change.

## Symmetry

Only port/starboard-symmetric tables are supported: `polar-format` requires
`symmetry.portStarboardSymmetric: true`, and all lookups here always mirror speed across the beam
(`Math.abs(twa)`). There is no asymmetric-table support yet.