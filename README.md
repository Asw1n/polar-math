# polar-math

Pure calculations for canonical `polar-format` polar tables. The package has no Signal K dependency.

`Polar.fromTable(table)` validates and prepares an immutable polar table once. All query methods accept
their dynamic inputs explicitly and return `{ value, state }`. Measurements use SI units: m/s and radians.

```js
const { Polar } = require('polar-math')

const polar = Polar.fromTable(table)
const speed = polar.speedAt({ tws, twa, performanceFactor: 0.95 })
const vmg = polar.vmgAt({ tws, twa, performanceFactor: 0.95 })
const targets = polar.targetsAt({ tws, performanceFactor: 0.95 })
const range = polar.rangeAt({ tws })
```

`state` always includes `available`. For valid queries it also includes the TWS range state and, for
angle-dependent calls, the TWA range state. Invalid numeric input (including a `twa` outside `[-π, π]`)
returns `value: null` and `state.reason: 'invalid_input'`.

`state.tws` is one of:
- `in_range` — within the table's TWS axis
- `below_range` — below the lowest TWS row (result is clamped to it)
- `above_range` — above the highest TWS row (result is clamped to it)

`state.twa` (angle-dependent calls only) is one of:
- `in_range` — within the sailable TWA range
- `pinching` — between the pinch boundary and the beat angle; a reduced positive speed is returned
- `in_irons` — below the pinch boundary; `speedAt`/`vmgAt` return `value: null`
- `extrapolated` — beyond the table's last real TWA point but within the modeled run extension
- `above_range` — beyond the modeled range; `speedAt`/`vmgAt` return `value: null`

The performance factor is deliberately a per-query input.

## Interpolation and extrapolation

Within a TWS row, a query angle that falls between two real points (measured axis columns, plus any
`derived.rows` beat/run target inserted into the same list) is always **linearly interpolated** between
them — this is genuine measured data, never a model. Between two TWS rows, results are linearly
interpolated the same way. Only angles *outside* the real data span (below the beat angle, or beyond the
last real point) fall back to a modeled extrapolation, described below.

### Beat-side (pinching)

Below the beat angle, speed is assumed to taper to zero at a fixed pinch angle (25°) using a quadratic fit
matched to the beat point's value and local slope. `rangeAt`'s reported `minTwa` sits at 90% of the beat
angle, a conservative boundary short of the full pinch angle. This model has not changed as part of the
run-side work below.

### Run-side (gybe)

The deepest real angle in a row is rarely 180° (dead downwind), but the polar plot is mirrored
port/starboard at 180°, so a query (or a rendered curve) needs *something* defined all the way there. The
run extension has two steps, both operating on **VMG** (`speed × |cos(twa)|`) rather than raw speed,
because VMG — not speed — is the quantity that peaks at the run angle and is expected to behave
predictably beyond it:

1. **Mirror point.** The run angle is a peak: VMG rises up to it and falls beyond it. As a first
   extrapolated point, the model assumes the fall mirrors the rise — the VMG at
   `runAngle + d` is assumed equal to the VMG already measured at `runAngle - d`, where `d` is the
   distance back to the nearest real axis point below the run angle. This adds **at most one** synthetic
   point, and only when it would land beyond the last real point and at or before 180°; if real data
   already reaches (or the mirror would overshoot) 180°, no mirror point is added.
2. **Taper to zero slope at 180°.** From the deepest known angle (the mirror point, or the last real
   point if no mirror was added), the VMG slope is assumed to decrease linearly to exactly zero at 180° —
   the point where the boat gybes and the polar mirrors onto itself, so VMG must be momentarily flat
   there. Integrating that linear slope gives a quadratic VMG curve out to 180°, converted back to boat
   speed at query time. Two safety clamps apply: speed is never negative, and VMG is never allowed to
   increase past its value at the deepest known angle.

Both steps are skipped if a row has no run target, too few points to establish a slope, or is already
complete out to 180°.

### Opting out: `extrapolate: false`

Every query method accepts `extrapolate` (default `true`). Pass `extrapolate: false` to restrict results to
real data only — no beat-side pinch taper, no run-side mirror/taper. `rangeAt` then reports the TWA span
actually covered by measured axis columns and derived targets, and `speedAt`/`vmgAt` return `value: null`
(`state.twa: 'below_range'`/`'above_range'`) for anything outside it. Use this when extrapolated data
would be misleading for the caller's purpose (e.g. feeding a live performance calculation) rather than
just for rendering a continuous curve.

## Symmetry

Only port/starboard-symmetric tables are supported: `polar-format` requires
`symmetry.portStarboardSymmetric: true`, and all lookups here always mirror speed across the beam
(`Math.abs(twa)`). There is no asymmetric-table support yet.