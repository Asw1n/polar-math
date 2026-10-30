# Polar-format v2 support: API specification

Status: agreed design for implementation. This document describes intended
behaviour, not functionality already available in the package.

## 1. Scope and responsibilities

Extend `polar-math` to consume canonical version-2 polar sets while preserving
version-1 table support. A prepared `Polar` represents exactly one polar table,
not a set of tables or an operational sailplan registry.

The library provides baseline speed and target calculations, heel/reef/flat
queries, wave-factor interpolation and optional effort-bounded optimization of
wave-adjusted targets.

Storage, vendor import, active-resource selection, inventory matching and
operational sailplan management remain outside this library.

All inputs and outputs use canonical SI units:

| Quantity | Unit / meaning |
| --- | --- |
| TWS, boat speed, VMG | m/s |
| TWA, heel, wave directions | radians |
| Significant wave height | metres |
| Wave period | seconds |
| Reef, flat, wave factor, performance factor | dimensionless |

Reef and flat are VPP model factors, not discrete reef indices or physical
control positions. Heel is an unsigned magnitude.

## 2. Loading and table selection

```js
const baseline = Polar.fromTable(v1Table)
const best = Polar.fromPolarSet(v2Set)
const selected = Polar.fromPolarSet(v2Set, sailplanId)
```

- Retain `fromTable` for canonical version-1 documents.
- Add `fromPolarSet` for canonical version-2 sets.
- Omitting the second argument selects `best`.
- A supplied sailplan ID selects that entry's table by its document-local ID.
- `best` is selected by omission, not by reserving an ID string.
- Validate the input using `polar-format`, including semantic validation.
- Preserve the selected table's root context: units, symmetry and optional
  vessel-wide wave correction.
- Preparation must not mutate the source document or depend on later mutations
  of it. Selection is fixed for the prepared instance.
- Invalid documents, unsupported versions and unknown sailplan IDs throw a
  descriptive `TypeError`. Never fall back to `best` after failed selection.

Loading errors are preparation/configuration errors. Invalid runtime queries
instead return unavailable result objects; they do not throw.

## 3. Existing query interface

Retain these options and their defaults:

```js
polar.speedAt({ tws, twa, performanceFactor: 1, extrapolate: true })
polar.vmgAt({ tws, twa, performanceFactor: 1, extrapolate: true })
polar.targetsAt({ tws, performanceFactor: 1, extrapolate: true })
polar.rangeAt({ tws, extrapolate: true })
```

Queries return `{ value, state }`.

- `speedAt`: numeric boat speed or `null`.
- `vmgAt`: signed wind-axis VMG, `speed * cos(twa)`, or `null`.
- `targetsAt`: the targets described below, or `null` for an invalid/unavailable
  overall query.
- `rangeAt`: `{ minTwa, maxTwa }`, or `null`.

Baseline speed interpolation remains PCHIP in TWA and linear in TWS. Retain the
existing documented baseline pinching and run-extension behaviour controlled by
`extrapolate`, except where data is insufficient to construct those extensions.

`performanceFactor` defaults to one and must be finite and nonnegative. It scales
speed and VMG, not angles or auxiliary quantities.

Baseline angle queries accept signed TWA within `[-pi, pi]` and mirror the
underlying symmetric table using its magnitude.

## 4. Nullable speed data and angular range

Version-2 speed matrices can contain null cells:

- Interior nulls are missing observations, not physical sailing gaps.
- Interpolate using surrounding known speed samples, skipping interior nulls.
- Leading and trailing nulls delimit the real-data angular range.
- Zero is a supplied numeric speed, not an unavailable marker.
- Preserve exact usable samples even when there are too few samples to
  interpolate elsewhere. Never invent a speed where interpolation cannot be
  supported.
- Source-supplied beat/run points remain baseline curve inputs under the
  existing preparation model.

`rangeAt` retains its existing single-interval shape. Do not add a `ranges` array.
Its bounds describe baseline model availability, not safety limits, sail
operating limits or wave-model coverage. With `extrapolate: false`, report the
real-data range; otherwise retain supported baseline extensions.

## 5. Heel, reef and flat queries

Add:

```js
polar.heelAt({ tws, twa })
polar.reefAt({ tws, twa })
polar.flatAt({ tws, twa })
```

Each returns `{ value, state }` with a numeric value or `null`.

- Use linear interpolation in TWA.
- Skip interior null samples and interpolate between surrounding known values.
- Preserve exact known samples.
- Do not extrapolate beyond that quantity's first/last known angular sample.
- Do not use synthetic speed points to invent auxiliary values.
- Use the same TWS interpolation, out-of-range clamping and TWS status mechanism
  as boat speed. At an exact stored TWS, use that row alone.
- For interpolation between TWS rows, both contributing rows must supply the
  requested quantity at that angle.
- An auxiliary quantity may have narrower coverage than boat speed.
- A missing quantity never makes boat speed unavailable.
- Performance factors and wave correction do not scale these quantities.
- If an `extrapolate` option is passed, it must not enable auxiliary angular
  extrapolation.

When the quantity cannot be supplied:

```js
{
  value: null,
  state: {
    available: false,
    reason: 'no_data',
    tws: 'in_range',
    twa: 'in_range'
  }
}
```

If the angle is below/above the quantity's known coverage, use
`twa: 'below_range'` / `'above_range'`. Entirely missing quantity data uses
`no_data`; do not manufacture numeric defaults such as heel zero or factor one.

## 6. Target values and auxiliary precedence

Extend the target result:

```js
{
  value: {
    beat: { twa, speed, vmg, heel, reef, flat },
    run: { twa, speed, vmg, heel, reef, flat },
    maxSpeed: { twa, speed, heel, reef, flat }
  },
  state
}
```

- Each unavailable target is `null`.
- Within an available target, unknown auxiliary fields are individually `null`.
- Beat/run VMG is a nonnegative magnitude, unlike signed `vmgAt`.
- Continue returning `speed`, while canonical stored targets use `tbs`.
- Target TWA is an unsigned magnitude, including on port tack.
- Stored derived targets need not be exactly reproducible from the sampled
  matrix and must not be discarded merely because of that difference.

At source target points, resolve each auxiliary quantity independently:

1. Prefer its source-supplied target value.
2. Otherwise sample its matrix at the target TWS/TWA.
3. Otherwise return `null`.

Between TWS rows, interpolate corresponding target auxiliary quantities linearly
only when both bounding target values are usable, after the above resolution.
Maximum-speed auxiliary values are sampled at the maximum-speed target.

For newly optimized wave-adjusted angles, sample baseline auxiliary data at those
new angles. The wave model supplies speed factors, not wave-adjusted predictions
of heel, reef or flat.

## 7. Sea-state inputs and validation

Speed and VMG queries optionally accept bow-relative sea state:

```js
polar.speedAt({
  tws,
  twa,
  performanceFactor: 1,
  extrapolate: true,
  seaState: {
    significantWaveHeight,
    wavePeriod,
    waveAngle
  }
})

polar.vmgAt({ tws, twa, seaState })
```

Target queries optionally accept wind-relative sea state:

```js
polar.targetsAt({
  tws,
  performanceFactor: 1,
  extrapolate: true,
  tack: 'starboard',
  optimizationBudget: 0,
  seaState: {
    significantWaveHeight,
    wavePeriod,
    waveDirectionRelativeToWind
  }
})
```

Validation:

- Significant wave height must be finite and nonnegative.
- Wave period must be finite and strictly positive.
- Bow-relative `waveAngle` must be finite and within `[0, pi]`.
- `waveDirectionRelativeToWind` must be finite and within `[-pi, pi]`.
- A supplied sea-state object must contain all required quantities for that
  query. Zero height still requires period and direction.
- Validate supplied input even if the polar has no wave model.
- Malformed/incomplete input returns `value: null`,
  `state.available: false`, `state.reason: 'invalid_input'`.
- Omitting `seaState` requests baseline behaviour.
- `tack` accepts `'starboard'` or `'port'`, defaulting to `'starboard'`.
- `optimizationBudget` is a nonnegative integer, defaulting to zero.

All wave directions use a "comes from" convention. Bow-relative zero means head
sea, `pi/2` beam sea and `pi` following sea.

Wind-relative wave direction is positive clockwise from the true-wind "from"
direction. Convert it to a bow-relative angle for every candidate heading and
fold to `[0, pi]`. With unsigned candidate TWA `a` and wind-relative wave
direction `d`, the relative direction before folding is `d + a` on starboard
tack and `d - a` on port tack. Do not hold bow-relative wave angle constant while
searching headings.

The two tack queries describe the same physical sea state:

```js
const seaState = {
  significantWaveHeight: 2,
  wavePeriod: 8,
  waveDirectionRelativeToWind: Math.PI / 3
}

const starboard = polar.targetsAt({ tws: 5.144, tack: 'starboard', seaState })
const port = polar.targetsAt({ tws: 5.144, tack: 'port', seaState })
```

Waves may produce different results on the two tacks despite symmetric baseline
wind tables and symmetric bow-relative wave factors.

## 8. Wave-factor query and interpolation

Add:

```js
polar.waveFactorAt({
  significantWaveHeight,
  wavePeriod,
  waveAngle
})
```

Return `{ value, state }`. The value is a dimensionless factor:

- Supported valid conditions: interpolated factor, including zero or values
  greater than one.
- Missing model: factor one, with correction not applied and reason `no_model`.
- Outside coverage: factor one, with correction not applied and reason
  `out_of_range`.
- Invalid input: `null` and main-state reason `invalid_input`.

Use linear interpolation in this order:

1. Wave angle within each contributing period row.
2. Period within each contributing height layer.
3. Significant wave height between contributing layers.

Each layer may have independent period/angle axes. Every contributing layer
must cover the requested period and angle. An exact height uses only that
layer; an exact period uses only that period row. Do not require unused
neighbours to cover an exact sample.

No wave-factor clamping or extrapolation. Partial coverage is not evidence that
a heading is physically unsailable.

## 9. Applying correction and fallback

```text
speed = baseline speed * wave factor * performance factor
```

| Condition | Behaviour |
| --- | --- |
| Sea state omitted | Baseline speed, including performance factor |
| Valid sea state, no model | Baseline fallback, `no_model` |
| Valid sea state outside coverage | Baseline fallback, `out_of_range` |
| Valid sea state inside coverage | Apply the wave factor |
| Invalid sea-state input | Invalid-input result, no baseline fallback |

Baseline availability still governs whether a speed can be supplied. A fallback
does not make unavailable baseline data available.

No hidden rounding of sea-state inputs, reuse for merely similar conditions or
assumption-based corrected-polar cache is required.

## 10. Wave-adjusted targets and search effort

With the default zero budget:

- Retain baseline beat/run/maximum-speed angles.
- Evaluate wave correction separately at each available target angle.
- Recalculate its speed and VMG using that factor and the performance factor.
- If correction is out of range at one target, fall back for that target only.
- Do not describe unchanged angles as wave-optimized.

With a positive budget:

- Search separately for corrected beat, run and maximum-speed angles.
- The budget applies independently to each search, not to the whole query.
- Express effort in candidate-angle evaluations rather than algorithm-specific
  iterations.
- Beat maximizes upwind VMG; run maximizes downwind VMG magnitude; maximum speed
  maximizes corrected boat speed.
- Derive the wave angle for each candidate and selected tack.
- Stored derived targets remain inputs to the baseline curve, not necessarily
  optima after correction.
- Consider supported candidates even if other probes are outside wave coverage.
- Skip out-of-range candidates. Never compare their uncorrected fallback speeds
  against corrected speeds as though they belonged to one objective.
- Return the best supported candidate found within the budget.
- If none is found for a target, use that target's baseline fallback and report
  `out_of_range`. Missing baseline targets remain unavailable.
- The result is best found within supported coverage and effort, not a guarantee
  of a global optimum.

The algorithm must allow for multiple promising regions; it must not assume a
single local optimum around the baseline target. Algorithm, candidate allocation,
tie-breaking and convergence tolerances are implementation decisions. Document
the evaluation accounting so the public budget remains a meaningful effort
bound; a zero search budget still permits evaluating correction at baseline
targets.

## 11. Result status

Preserve the outer `{ value, state }` structure and existing range state fields.
Use `available: false` when the requested value cannot be supplied, including
invalid input and missing baseline/auxiliary data. A usable baseline fallback
remains `available: true`.

Retain existing TWS states (`in_range`, `below_range`, `above_range`) and existing
baseline TWA states where applicable. TWS clamping is separate from the strict
no-extrapolation rule for wave-model axes.

For `speedAt`, `vmgAt` and `waveFactorAt`, report:

```js
waveCorrection: {
  applied: true,
  reason: null
}
```

Correction reasons when not applied:

- `not_requested`: sea state omitted from a speed/target query.
- `no_model`: valid inputs but no wave correction model.
- `out_of_range`: valid inputs outside model coverage.

`applied: true` means a supported factor was evaluated, even if it equals one.
For `waveFactorAt`, this records model evaluation, not multiplication of a boat
speed.

For `targetsAt`, correction status is per target, because coverage may differ:

```js
state: {
  available: true,
  tws: 'in_range',
  twa: null,
  waveCorrection: {
    beat: { applied: true, reason: null },
    run: { applied: true, reason: null },
    maxSpeed: { applied: false, reason: 'out_of_range' }
  },
  optimization: {
    beat: { status: 'budget_exhausted', evaluations: 20 },
    run: { status: 'converged', evaluations: 14 },
    maxSpeed: { status: 'not_applicable', evaluations: 0 }
  }
}
```

Optimization statuses:

| Status | Meaning |
| --- | --- |
| `not_requested` | Zero search budget |
| `not_applicable` | No wave correction can be applied |
| `unavailable` | Target cannot be evaluated |
| `budget_exhausted` | Search effort limit reached; return best supported result |
| `converged` | Implementation's documented stopping criterion met |

Convergence is not a guarantee of the global optimum. Evaluation counts describe
search effort per target. Baseline fallback/invalid-input reasons must remain
visible rather than success-shaped silent defaults.

Unknown auxiliary fields inside an available target remain null, without
per-field status objects or making that target unavailable.

## 12. Acceptance criteria

Tests must cover:

- Existing version-1 speed, VMG, targets, range, performance-factor and
  extrapolation behaviour.
- Version-2 best/default and explicit sailplan selection, retained wave context,
  independent preparation, invalid loading and unknown IDs.
- Interior/edge null speed samples, exact known samples, insufficient data and
  unchanged single-range results.
- Independent heel/reef/flat linear interpolation, interior nulls, narrower
  angular coverage, TWS interpolation/clamping and no synthetic extrapolation.
- Supplied target auxiliary precedence, matrix fallback, individual unknown
  fields, maximum-speed auxiliary values and positive target VMG magnitudes.
- Complete/invalid sea states, zero height, direction ranges, tack conventions
  and validation even without a model.
- Wave interpolation with independent grids, exact-axis samples, factors above
  one/zero, missing models, out-of-range fallback and no clamping.
- Signed `vmgAt` versus magnitude target VMG, with wave and performance factors
  applied exactly once.
- Zero-budget unchanged angles, separate target fallbacks, positive-budget
  improved candidates, multiple promising regions and per-search effort bounds.
- Mixed supported/out-of-range probes, per-target coverage and no comparison of
  corrected candidates against uncorrected fallbacks.
- Accurate availability, correction and optimization status for usable results,
  fallback results, unknown auxiliary values and unavailable targets.

Benchmark repeated speed/target queries and bounded target searches with
representative routing workloads. Report preparation cost and per-query cost;
do not assume slow sea-state changes or useful cache hit rates.

## 13. Rollout

Implement and verify library support before updating consumers. Preserve v1
loaders while consumers adopt the new set loader. Update management and dependent
plugins before enabling v2 storage/selection in their shared workflows. Do not
automatically migrate persisted resources as a side effect of calculation.

This specification does not authorize runtime implementation, cross-project
changes, publishing or version bumps by itself.
