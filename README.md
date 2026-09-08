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
- `extrapolated` — beyond the table's last TWA column but within the modeled run extrapolation
- `above_range` — beyond the run extrapolation limit; `speedAt`/`vmgAt` return `value: null`

The performance factor is deliberately a per-query input. 

## Symmetry

Only port/starboard-symmetric tables are supported: `polar-format` requires
`symmetry.portStarboardSymmetric: true`, and all lookups here always mirror speed across the beam
(`Math.abs(twa)`). There is no asymmetric-table support yet.