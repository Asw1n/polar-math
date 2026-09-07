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
angle-dependent calls, the TWA range state. Invalid numeric input returns `value: null` and
`state.reason: 'invalid_input'`.

The performance factor is deliberately a per-query input. A Signal K plugin may subscribe to a shared
`vessels.self.polars.performanceFactor` setting and pass its current value to every query.