'use strict'

const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const { Polar } = require('polar-math')
const { fixture, radians } = require('../test/fixtures')

const set = fixture()
set.best.axes = {
  tws: Array.from({ length: 12 }, (_, index) => 2 + index * 1.5),
  twa: Array.from({ length: 31 }, (_, index) => radians(30 + index * 5))
}
set.best.values = {
  boatSpeedMatrix: set.best.axes.tws.map(tws => set.best.axes.twa.map(twa => tws * (0.25 + 0.4 * Math.sin(twa)))),
  heelMatrix: set.best.axes.tws.map(tws => set.best.axes.twa.map(twa => Math.min(1, tws * Math.sin(twa) / 30)))
}
delete set.best.derived
set.sailplans = Array.from({ length: 4 }, (_, index) => ({
  id: `plan-${index}`, name: `Sail combination ${index}`, table: structuredClone(set.best)
}))
const v1 = {
  ...set.best, kind: 'polarTable', schemaVersion: '1.0.0', units: set.units, symmetry: set.symmetry,
  values: { boatSpeedMatrix: set.best.values.boatSpeedMatrix }
}
const queries = Array.from({ length: 1024 }, (_, index) => ({
  tws: 2 + ((index * 17) % 165) / 10,
  twa: radians(35 + ((index * 13) % 145)),
  performanceFactor: 0.85 + (index % 10) / 100,
  seaState: {
    significantWaveHeight: 1 + (index % 19) / 10,
    wavePeriod: 6 + (index % 39) / 10,
    waveAngle: radians(25 + (index * 7) % 130)
  }
}))
const targetQueries = queries.map((query, index) => ({
  tws: query.tws, performanceFactor: query.performanceFactor,
  tack: index % 2 ? 'port' : 'starboard',
  seaState: {
    significantWaveHeight: query.seaState.significantWaveHeight,
    wavePeriod: query.seaState.wavePeriod,
    waveDirectionRelativeToWind: radians(-170 + (index * 11) % 340)
  }
}))
const baselineQueries = queries.map(({ seaState, ...query }) => query)
let checksum = 0
function measure(label, count, operation) {
  for (let index = 0; index < Math.min(count, 1000); index += 1) operation(index)
  const samples = []
  for (let repeat = 0; repeat < 5; repeat += 1) {
    const start = performance.now()
    for (let index = 0; index < count; index += 1) operation(index)
    samples.push((performance.now() - start) * 1000 / count)
  }
  samples.sort((a, b) => a - b)
  console.log(`${label}: median ${samples[2].toFixed(3)} us/op; range ${samples[0].toFixed(3)}-${samples[4].toFixed(3)}; ${count} ops/sample`)
}
console.log(`Node ${process.version}; ${process.platform}/${process.arch}; 12 TWS x 31 TWA, best + 4 sailplans; no corrected-polar cache`)
measure('prepare v1 (validation + preparation)', 250, () => { checksum += Polar.fromTable(v1).entries.length })
measure('prepare v2 (whole-set validation + selected-table preparation)', 250, () => {
  checksum += Polar.fromPolarSet(set).entries.length
})
const polar = Polar.fromPolarSet(set)
measure('baseline speedAt', 100000, index => {
  const result = polar.speedAt(baselineQueries[index % queries.length])
  assert.notEqual(result.value, null)
  checksum += result.value
})
measure('wave speedAt, changing sea states', 100000, index => {
  const result = polar.speedAt(queries[index % queries.length])
  assert.notEqual(result.value, null)
  checksum += result.value
})
measure('baseline targetsAt', 10000, index => {
  checksum += polar.targetsAt({ tws: queries[index % queries.length].tws }).value.maxSpeed.speed
})
measure('wave targetsAt, budget 0', 10000, index => {
  checksum += polar.targetsAt(targetQueries[index % queries.length]).value.maxSpeed.speed
})
for (const budget of [20, 100]) {
  measure(`wave targetsAt, budget ${budget} PER target`, 1000, index => {
    const result = polar.targetsAt({ ...targetQueries[index % queries.length], optimizationBudget: budget })
    for (const optimization of Object.values(result.state.optimization)) assert.ok(optimization.evaluations <= budget)
    checksum += result.value.maxSpeed.speed
  })
}
assert.ok(Number.isFinite(checksum) && checksum > 0)
console.log(`checksum: ${checksum.toFixed(3)}`)
