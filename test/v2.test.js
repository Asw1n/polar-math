'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('node:test')
const { Polar } = require('polar-math')
const { fixture, radians, target } = require('./fixtures')
const close = (actual, expected, tolerance = 1e-9) => assert.ok(
  Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`
)
const q = { tws: 5, twa: radians(90) }
const bow = { significantWaveHeight: 1, wavePeriod: 8, waveAngle: radians(90) }
const wind = { significantWaveHeight: 1, wavePeriod: 8, waveDirectionRelativeToWind: radians(30) }

describe('v2 preparation and nullable curves', () => {
  it('selects best by omission and accepts a sailplan literally named best', () => {
    const set = fixture()
    const selected = structuredClone(set.best)
    selected.values.boatSpeedMatrix[0][2] = 9
    set.sailplans = [{ id: 'best', name: 'Descriptive only', table: selected }]
    assert.equal(Polar.fromPolarSet(set).speedAt(q).value, 6)
    assert.equal(Polar.fromPolarSet(set, 'best').speedAt(q).value, 9)
    assert.equal(Polar.fromPolarSet(set, 'best').waveFactorAt(bow).state.waveCorrection.applied, true)
    for (const id of ['unknown', '', null, 4]) assert.throws(() => Polar.fromPolarSet(set, id), /Unknown.*ID/)
  })

  it('validates complete documents and rejects wrong loaders, versions and semantic errors', () => {
    const set = fixture()
    const v1 = { ...set.best, kind: 'polarTable', schemaVersion: '1.0.0', units: set.units, symmetry: set.symmetry }
    delete v1.values.heelMatrix
    delete v1.values.reefMatrix
    delete v1.derived
    assert.ok(Polar.fromTable(v1))
    assert.throws(() => Polar.fromPolarSet(v1), /TypeError|Invalid polar set/)
    assert.throws(() => Polar.fromTable(set), TypeError)
    for (const value of [null, {}, { ...set, schemaVersion: '3.0.0' }]) {
      assert.throws(() => Polar.fromPolarSet(value), TypeError)
    }
    set.best.axes.tws = [10, 5]
    assert.throws(() => Polar.fromPolarSet(set), /increasing/)
    const bad = fixture()
    bad.sailplans = [{ id: 'unused', name: 'invalid even if not selected', table: {} }]
    assert.throws(() => Polar.fromPolarSet(bad), TypeError)
  })

  it('does not mutate or retain mutable source structures, including v1', () => {
    const set = fixture()
    const before = structuredClone(set)
    const polar = Polar.fromPolarSet(set)
    assert.deepEqual(set, before)
    const result = polar.targetsAt({ tws: 5, seaState: wind })
    set.best.values.boatSpeedMatrix[0][2] = 900
    set.best.derived.rows[0].beat.heel = 0
    set.waveCorrection.heights[0].values.speedFactorMatrix[1][1] = 99
    assert.equal(polar.speedAt(q).value, 6)
    assert.deepEqual(polar.targetsAt({ tws: 5, seaState: wind }), result)
    result.value.beat.heel = 0
    assert.equal(polar.targetsAt({ tws: 5 }).value.beat.heel, 0.7)
    assert.throws(() => { polar.entries[1].targetAux.beat.heel = 0 }, TypeError)
    const v1 = { kind: 'polarTable', schemaVersion: '1.0.0', units: before.units, symmetry: before.symmetry,
      axes: { tws: [5], twa: [1, 2] }, values: { boatSpeedMatrix: [[3, 4]] } }
    const legacy = Polar.fromTable(v1)
    v1.values.boatSpeedMatrix[0][0] = 50
    assert.equal(legacy.speedAt({ tws: 5, twa: 1 }).value, 3)
  })

  it('skips interior nulls, trims edge nulls and preserves zero samples', () => {
    const set = fixture()
    set.best = {
      axes: { tws: [5], twa: [20, 40, 60, 90, 120, 150, 180].map(radians) },
      values: { boatSpeedMatrix: [[null, 0, null, 6, null, 3, null]] }
    }
    const polar = Polar.fromPolarSet(set)
    assert.equal(polar.speedAt({ tws: 5, twa: radians(40), extrapolate: false }).value, 0)
    assert.ok(polar.speedAt({ tws: 5, twa: radians(60), extrapolate: false }).value > 0)
    assert.equal(polar.speedAt({ tws: 5, twa: radians(20), extrapolate: false }).value, null)
    assert.deepEqual(polar.rangeAt({ tws: 5, extrapolate: false }).value, { minTwa: radians(40), maxTwa: radians(150) })
    assert.deepEqual(Object.keys(polar.rangeAt({ tws: 5 }).value), ['minTwa', 'maxTwa'])
  })

  it('preserves lone exact samples without extrapolating and reports entirely missing data', () => {
    const set = fixture()
    set.best = { axes: { tws: [5], twa: [1, 2, 3] }, values: { boatSpeedMatrix: [[null, 0, null]] } }
    const polar = Polar.fromPolarSet(set)
    assert.equal(polar.speedAt({ tws: 5, twa: 2 }).value, 0)
    for (const twa of [1.9, 2.1]) {
      const result = polar.speedAt({ tws: 5, twa })
      assert.equal(result.value, null)
      assert.equal(result.state.available, false)
    }
    set.best.values.boatSpeedMatrix[0][1] = null
    const empty = Polar.fromPolarSet(set)
    for (const method of ['speedAt', 'vmgAt', 'rangeAt', 'targetsAt']) {
      assert.equal(empty[method](q).state.reason, 'no_data')
      assert.equal(empty[method](q).state.available, false)
    }
  })

  it('uses only exact TWS rows and reports the common available interval between rows', () => {
    const set = fixture()
    set.best = {
      axes: { tws: [5, 10], twa: [0.5, 1, 2, 3] },
      values: { boatSpeedMatrix: [[null, 2, 3, null], [1, 2, null, null]] }
    }
    const polar = Polar.fromPolarSet(set)
    assert.equal(polar.speedAt({ tws: 5, twa: 2, extrapolate: false }).value, 3)
    assert.deepEqual(polar.rangeAt({ tws: 7, extrapolate: false }).value, { minTwa: 1, maxTwa: 1 })
    assert.equal(polar.speedAt({ tws: 7, twa: 2, extrapolate: false }).state.available, false)
    set.best.values.boatSpeedMatrix[1] = [1, null, null, null]
    assert.equal(Polar.fromPolarSet(set).rangeAt({ tws: 7, extrapolate: false }).value, null)
  })

  it('does not hide real samples below a supplied beat target or discard standalone stored extrema', () => {
    const set = fixture()
    set.best.derived.rows[0].beat = target(60, 5)
    assert.equal(Polar.fromPolarSet(set).speedAt({ tws: 5, twa: radians(40) }).value, 3)
    set.best = {
      axes: { tws: [5], twa: [1, 2] }, values: { boatSpeedMatrix: [[null, null]] },
      derived: { rows: [{ tws: 5, maxSpeed: 4, maxSpeedAngle: 1 }] }
    }
    const lone = Polar.fromPolarSet(set)
    assert.equal(lone.targetsAt({ tws: 5 }).value.maxSpeed.speed, 4)
    assert.equal(lone.speedAt({ tws: 5, twa: 1 }).value, 4)
    assert.equal(lone.speedAt({ tws: 5, twa: 0.9 }).state.twa, 'below_range')
  })
})

describe('auxiliary quantities and targets', () => {
  const polar = Polar.fromPolarSet(fixture())

  it('uses independent linear angular interpolation, exact samples and TWS interpolation/clamping', () => {
    close(polar.heelAt(q).value, 0.3)
    close(polar.heelAt({ ...q, twa: -q.twa, tws: 7.5 }).value, 0.45)
    close(polar.heelAt({ ...q, tws: 0 }).value, 0.3)
    assert.equal(polar.heelAt({ ...q, tws: 0 }).state.tws, 'below_range')
    close(polar.heelAt({ ...q, tws: 20 }).value, 0.6)
    assert.equal(polar.heelAt({ ...q, tws: 20 }).state.tws, 'above_range')
    close(polar.reefAt(q).value, 1)
    close(polar.reefAt({ ...q, twa: radians(105) }).value, 0.9)
  })

  it('does not invent auxiliary values from speed extensions or scale them', () => {
    for (const extrapolate of [true, false]) {
      const result = polar.reefAt({ tws: 5, twa: radians(40), extrapolate })
      assert.equal(result.value, null)
      assert.equal(result.state.twa, 'below_range')
      assert.equal(result.state.available, false)
    }
    assert.equal(polar.reefAt({ tws: 5, twa: Math.PI }).state.twa, 'above_range')
    assert.deepEqual(polar.flatAt(q), {
      value: null, state: { available: false, reason: 'no_data', tws: 'in_range', twa: 'in_range' }
    })
    close(polar.heelAt({ ...q, performanceFactor: 0, seaState: bow }).value, 0.3)
    assert.equal(polar.speedAt(q).state.available, true)
  })

  it('requires both contributing rows but not unused neighbours or two samples for an exact point', () => {
    const set = fixture()
    set.best.values.heelMatrix[1] = [null, null, null, null, null, null]
    const sparse = Polar.fromPolarSet(set)
    close(sparse.heelAt(q).value, 0.3)
    assert.equal(sparse.heelAt({ ...q, tws: 6 }).value, null)
    set.best.values.heelMatrix[0] = [null, 0, null, null, null, null]
    const lone = Polar.fromPolarSet(set)
    assert.equal(lone.heelAt({ tws: 5, twa: radians(60) }).value, 0)
    assert.equal(lone.heelAt(q).value, null)
  })

  it('resolves target fields independently before interpolating TWS rows', () => {
    const at5 = polar.targetsAt({ tws: 5 }).value
    assert.deepEqual(at5.beat, { twa: radians(40), speed: 3, vmg: 2.3, heel: 0.7, reef: null, flat: 0.9 })
    close(at5.run.heel, 0.3)
    close(at5.run.reef, 0.8)
    assert.equal(at5.run.flat, null)
    close(at5.maxSpeed.heel, 0.3)
    close(polar.targetsAt({ tws: 7.5 }).value.beat.heel, 0.8)
    close(polar.targetsAt({ tws: 7.5 }).value.beat.flat, 0.8)
    close(polar.targetsAt({ tws: 7.5 }).value.run.heel, 0.45)
    close(polar.targetsAt({ tws: 5, performanceFactor: 0.5 }).value.beat.heel, 0.7)
  })

  it('retains independently supplied targets and extrema, with magnitude VMG', () => {
    const set = fixture()
    set.best.derived.rows[0].beat = { ...target(50, 20, { reef: 1.1 }), vmg: 12.345 }
    set.best.derived.rows[0].maxSpeed = 25
    set.best.derived.rows[0].maxSpeedAngle = radians(80)
    const stored = Polar.fromPolarSet(set)
    const result = stored.targetsAt({ tws: 5 }).value
    assert.equal(result.beat.speed, 20)
    assert.equal(result.beat.vmg, 12.35)
    assert.equal(result.beat.reef, 1.1)
    assert.equal(result.maxSpeed.speed, 25)
    assert.equal(result.maxSpeed.twa, radians(80))
    assert.ok(result.run.vmg >= 0)
    assert.ok(stored.vmgAt({ tws: 5, twa: radians(150) }).value < 0)
  })

  it('leaves a target auxiliary unknown between rows if either resolved value is missing', () => {
    const set = fixture()
    delete set.best.derived.rows[1].beat.flat
    assert.equal(Polar.fromPolarSet(set).targetsAt({ tws: 7.5 }).value.beat.flat, null)
  })
})

describe('wave interpolation and query validation', () => {
  const polar = Polar.fromPolarSet(fixture())

  it('interpolates angle, period then height across independent axes', () => {
    close(polar.waveFactorAt(bow).value, 0.8)
    close(polar.waveFactorAt({ ...bow, significantWaveHeight: 3 }).value, 0.6)
    close(polar.waveFactorAt({ ...bow, significantWaveHeight: 2 }).value, 0.7)
    close(polar.waveFactorAt({ ...bow, significantWaveHeight: 1, wavePeriod: 6 }).value, 0.8)
    assert.deepEqual(polar.waveFactorAt(bow).state.waveCorrection, { applied: true, reason: null })
  })

  it('uses only contributing layers at exact heights and permits factors zero and above one', () => {
    const query = { ...bow, wavePeriod: 4, waveAngle: 0 }
    assert.equal(polar.waveFactorAt(query).value, 0)
    close(polar.waveFactorAt({ ...query, waveAngle: Math.PI }).value, 1.5)
    const unsupported = polar.waveFactorAt({ ...query, significantWaveHeight: 2 })
    assert.equal(unsupported.value, 1)
    assert.equal(unsupported.state.waveCorrection.reason, 'out_of_range')
    const set = fixture()
    set.waveCorrection.heights.unshift({
      significantWaveHeight: 0, axes: { wavePeriod: [8], waveAngle: [0, Math.PI] },
      values: { speedFactorMatrix: [[1, 1]] }
    })
    assert.equal(Polar.fromPolarSet(set).waveFactorAt({ ...bow, significantWaveHeight: 0 }).value, 1)
  })

  it('does not clamp wave axes; no-model and range fallbacks retain performance scaling', () => {
    for (const seaState of [
      { ...bow, significantWaveHeight: 0 }, { ...bow, significantWaveHeight: 4 },
      { ...bow, wavePeriod: 3 }, { ...bow, wavePeriod: 13 },
      { ...bow, significantWaveHeight: 3, waveAngle: 0 }
    ]) {
      const result = polar.speedAt({ ...q, seaState, performanceFactor: 0.5 })
      assert.equal(result.value, 3)
      assert.equal(result.state.available, true)
      assert.equal(result.state.waveCorrection.reason, 'out_of_range')
    }
    const set = fixture()
    delete set.waveCorrection
    const noModel = Polar.fromPolarSet(set)
    assert.equal(noModel.speedAt({ ...q, seaState: bow, performanceFactor: 0.5 }).value, 3)
    assert.equal(noModel.waveFactorAt(bow).state.waveCorrection.reason, 'no_model')
    assert.equal(noModel.waveFactorAt(bow).value, 1)
  })

  it('applies wave and performance factors once, preserving signed scalar VMG', () => {
    close(polar.speedAt({ ...q, seaState: bow, performanceFactor: 0.5 }).value, 2.4)
    const down = { ...q, twa: radians(150), seaState: bow, performanceFactor: 0.5 }
    close(polar.vmgAt(down).value, 4.5 * 0.8 * 0.5 * Math.cos(down.twa))
    const stopped = { ...bow, wavePeriod: 4, waveAngle: 0 }
    assert.equal(polar.speedAt({ ...q, seaState: stopped }).value, 0)
    const unavailable = polar.speedAt({ tws: 5, twa: 0, seaState: bow })
    assert.equal(unavailable.value, null)
    assert.equal(unavailable.state.available, false)
  })

  it('rejects malformed, incomplete and nonfinite sea states even at zero height or without a model', () => {
    const set = fixture()
    delete set.waveCorrection
    for (const instance of [polar, Polar.fromPolarSet(set)]) {
      for (const seaState of [
        null, [], 1, {}, { significantWaveHeight: 0 }, { ...bow, wavePeriod: 0 },
        { ...bow, significantWaveHeight: -1 }, { ...bow, significantWaveHeight: Infinity },
        { ...bow, wavePeriod: NaN }, { ...bow, waveAngle: -0.1 }, { ...bow, waveAngle: Math.PI + 0.1 }
      ]) {
        for (const method of ['speedAt', 'vmgAt']) {
          const result = instance[method]({ ...q, seaState })
          assert.equal(result.value, null)
          assert.equal(result.state.reason, 'invalid_input')
        }
        assert.equal(instance.waveFactorAt(seaState).state.reason, 'invalid_input')
      }
    }
  })

  it('does not throw on invalid runtime options', () => {
    for (const options of [undefined, null, {}, 1, 'bad', [], { tws: Infinity }, { tws: 5, twa: Math.PI + 1 },
      { ...q, performanceFactor: -1 }, { ...q, performanceFactor: Infinity }]) {
      for (const method of ['speedAt', 'vmgAt', 'heelAt', 'reefAt', 'flatAt']) {
        assert.equal(polar[method](options).state.reason, 'invalid_input')
      }
    }
    for (const options of [
      { tws: 5, optimizationBudget: -1 }, { tws: 5, optimizationBudget: 0.1 },
      { tws: 5, optimizationBudget: Infinity }, { tws: 5, tack: 'left' },
      { tws: 5, seaState: bow }, { tws: 5, seaState: { ...wind, waveDirectionRelativeToWind: -Math.PI - 0.1 } },
      { tws: 5, seaState: { significantWaveHeight: 0, wavePeriod: 8 } }
    ]) assert.equal(polar.targetsAt(options).state.reason, 'invalid_input')
  })
})

describe('wave-adjusted targets and bounded multi-region search', () => {
  const polar = Polar.fromPolarSet(fixture())

  it('keeps zero-budget angles and target auxiliaries, with per-target correction', () => {
    const base = polar.targetsAt({ tws: 5 })
    const result = polar.targetsAt({ tws: 5, seaState: wind, performanceFactor: 0.5 })
    for (const name of ['beat', 'run', 'maxSpeed']) {
      assert.equal(result.value[name].twa, base.value[name].twa)
      assert.equal(result.value[name].heel, base.value[name].heel)
      const waveAngle = Math.abs(Math.atan2(Math.sin(wind.waveDirectionRelativeToWind + base.value[name].twa),
        Math.cos(wind.waveDirectionRelativeToWind + base.value[name].twa)))
      const factor = polar.waveFactorAt({ ...wind, waveAngle }).value
      close(result.value[name].speed, base.value[name].speed * factor * 0.5)
      assert.deepEqual(result.state.optimization[name], { status: 'not_requested', evaluations: 0 })
      assert.equal(base.state.waveCorrection[name].reason, 'not_requested')
      assert.equal(result.state.waveCorrection[name].applied, true)
    }
    close(result.value.run.vmg, result.value.run.speed * Math.abs(Math.cos(result.value.run.twa)))
  })

  it('implements the documented tack signs and unsigned output angles', () => {
    for (const tack of ['starboard', 'port']) {
      const result = polar.targetsAt({ tws: 5, seaState: wind, tack })
      const angle = result.value.beat.twa
      const direction = wind.waveDirectionRelativeToWind + (tack === 'port' ? -angle : angle)
      const waveAngle = Math.abs(Math.atan2(Math.sin(direction), Math.cos(direction)))
      close(result.value.beat.speed, 3 * polar.waveFactorAt({ ...wind, waveAngle }).value)
      assert.ok(angle >= 0)
    }
    assert.notEqual(polar.targetsAt({ tws: 5, seaState: wind, tack: 'port' }).value.beat.speed,
      polar.targetsAt({ tws: 5, seaState: wind }).value.beat.speed)
  })

  it('folds exact head/following directions without trigonometric boundary drift', () => {
    const set = fixture()
    set.best = { axes: { tws: [5], twa: [Math.PI] }, values: { boatSpeedMatrix: [[3]] } }
    set.waveCorrection.heights = [{
      significantWaveHeight: 1, axes: { wavePeriod: [8], waveAngle: [0] },
      values: { speedFactorMatrix: [[0.5]] }
    }]
    const boundary = Polar.fromPolarSet(set)
    for (const tack of ['starboard', 'port']) {
      const result = boundary.targetsAt({
        tws: 5, tack, seaState: { ...wind, waveDirectionRelativeToWind: Math.PI }
      })
      assert.equal(result.value.run.speed, 1.5)
      assert.equal(result.state.waveCorrection.run.applied, true)
    }
  })

  it('recomputes direction at every optimized heading, including mirrored port searches', () => {
    const port = polar.targetsAt({ tws: 5, tack: 'port', seaState: wind, optimizationBudget: 100 })
    const mirrored = polar.targetsAt({
      tws: 5, seaState: { ...wind, waveDirectionRelativeToWind: -wind.waveDirectionRelativeToWind },
      optimizationBudget: 100
    })
    for (const name of ['beat', 'run', 'maxSpeed']) {
      close(port.value[name].twa, mirrored.value[name].twa)
      close(port.value[name].speed, mirrored.value[name].speed)
      const twa = port.value[name].twa
      const direction = wind.waveDirectionRelativeToWind - twa
      const waveAngle = Math.abs(Math.atan2(Math.sin(direction), Math.cos(direction)))
      close(port.value[name].speed, polar.speedAt({ tws: 5, twa, seaState: { ...wind, waveAngle } }).value)
    }
  })

  it('preserves supplied auxiliaries when a searched target retains its baseline angle', () => {
    const result = polar.targetsAt({ tws: 5, seaState: wind, optimizationBudget: 1 })
    close(result.value.beat.heel, 0.7)
    close(result.value.beat.flat, 0.9)
    assert.equal(result.state.optimization.beat.evaluations, 1)
  })

  it('reports individual baseline fallbacks and does not mistake unsupported probes for corrected candidates', () => {
    const set = fixture()
    set.waveCorrection.heights = [{
      significantWaveHeight: 1, axes: { wavePeriod: [8], waveAngle: [80, 100].map(radians) },
      values: { speedFactorMatrix: [[0.1, 0.1]] }
    }]
    const narrow = Polar.fromPolarSet(set)
    const seaState = { ...wind, waveDirectionRelativeToWind: 0 }
    const baseline = narrow.targetsAt({ tws: 5 })
    const zero = narrow.targetsAt({ tws: 5, seaState })
    assert.equal(zero.state.waveCorrection.beat.reason, 'out_of_range')
    assert.equal(zero.state.waveCorrection.run.reason, 'out_of_range')
    assert.equal(zero.state.waveCorrection.maxSpeed.applied, true)
    const result = narrow.targetsAt({ tws: 5, seaState, optimizationBudget: 100 })
    assert.equal(result.state.waveCorrection.beat.applied, true)
    assert.ok(result.value.beat.speed < baseline.value.beat.speed)
    assert.ok(result.value.beat.twa >= radians(80) && result.value.beat.twa <= radians(90))
    assert.equal(result.state.waveCorrection.run.applied, true)
    assert.ok(result.value.run.speed < baseline.value.run.speed)
    const tiny = narrow.targetsAt({ tws: 5, seaState, optimizationBudget: 1 })
    assert.deepEqual(tiny.value.beat, baseline.value.beat)
    assert.equal(tiny.state.waveCorrection.beat.reason, 'out_of_range')
    assert.deepEqual(tiny.state.optimization.beat, { status: 'not_applicable', evaluations: 1 })
    assert.deepEqual(tiny.value.run, baseline.value.run)
    assert.equal(tiny.state.waveCorrection.run.reason, 'out_of_range')
    assert.equal(tiny.state.waveCorrection.maxSpeed.applied, true)
  })

  it('bounds evaluation counts per target and improves across multiple promising regions', () => {
    const set = fixture()
    set.waveCorrection.heights = [{
      significantWaveHeight: 1,
      axes: { wavePeriod: [8], waveAngle: [0, 40, 50, 60, 70, 90, 110, 125, 140, 160, 180].map(radians) },
      values: { speedFactorMatrix: [[0.1, 0.5, 1.5, 0.1, 2, 0.2, 0.1, 2, 0.1, 0.5, 0.1]] }
    }]
    const multi = Polar.fromPolarSet(set)
    const seaState = { ...wind, waveDirectionRelativeToWind: 0 }
    const baseline = multi.targetsAt({ tws: 5, seaState })
    const result = multi.targetsAt({ tws: 5, seaState, optimizationBudget: 2048 })
    for (const name of ['beat', 'run', 'maxSpeed']) {
      const status = result.state.optimization[name]
      assert.equal(status.evaluations, 2048)
      assert.equal(status.status, 'budget_exhausted')
      assert.equal(result.state.waveCorrection[name].applied, true)
      const objective = value => name === 'maxSpeed' ? value.speed : value.vmg
      assert.ok(objective(result.value[name]) >= objective(baseline.value[name]))
      let oracle = 0
      const from = name === 'run' ? 90 : multi.rangeAt({ tws: 5 }).value.minTwa * 180 / Math.PI
      const to = name === 'beat' ? 90 : 180
      for (let degrees = from; degrees <= to; degrees += 0.01) {
        const twa = radians(degrees)
        const speed = multi.speedAt({ tws: 5, twa, seaState: { ...bow, waveAngle: twa } }).value
        oracle = Math.max(oracle, name === 'maxSpeed' ? speed : speed * Math.abs(Math.cos(twa)))
      }
      assert.ok(objective(result.value[name]) >= oracle * 0.995)
      close(result.value[name].heel, multi.heelAt({ tws: 5, twa: result.value[name].twa }).value)
    }
    for (const budget of [1, 2, 3, 7, 20]) {
      const bounded = multi.targetsAt({ tws: 5, seaState, optimizationBudget: budget })
      for (const state of Object.values(bounded.state.optimization)) assert.ok(state.evaluations <= budget)
    }
  })

  it('separates not-requested, not-applicable, unavailable and converged statuses', () => {
    assert.equal(polar.targetsAt({ tws: 5, optimizationBudget: 10 }).state.optimization.beat.status, 'not_applicable')
    const set = fixture()
    delete set.waveCorrection
    assert.equal(Polar.fromPolarSet(set).targetsAt({ tws: 5, seaState: wind, optimizationBudget: 10 })
      .state.optimization.beat.status, 'not_applicable')
    set.best = { axes: { tws: [5], twa: [2] }, values: { boatSpeedMatrix: [[3]] } }
    set.waveCorrection = fixture().waveCorrection
    const lone = Polar.fromPolarSet(set)
    const result = lone.targetsAt({ tws: 5, seaState: wind, optimizationBudget: 10 })
    assert.equal(result.value.beat, null)
    assert.equal(result.state.optimization.beat.status, 'unavailable')
    assert.equal(result.state.optimization.run.status, 'converged')
    assert.equal(result.state.optimization.run.evaluations, 1)
    const unsupported = polar.targetsAt({ tws: 5, seaState: { ...wind, wavePeriod: 100 }, optimizationBudget: 10 })
    for (const name of ['beat', 'run', 'maxSpeed']) {
      assert.equal(unsupported.state.waveCorrection[name].reason, 'out_of_range')
      assert.equal(unsupported.state.optimization[name].status, 'not_applicable')
      assert.equal(unsupported.state.optimization[name].evaluations, 10)
    }
  })

  it('converges only after covering every remaining interval to the documented angular tolerance', () => {
    const set = fixture()
    set.best = { axes: { tws: [5], twa: [2, 2.000001] }, values: { boatSpeedMatrix: [[3, 3.1]] } }
    const result = Polar.fromPolarSet(set).targetsAt({
      tws: 5, extrapolate: false, seaState: wind, optimizationBudget: 10
    })
    for (const name of ['run', 'maxSpeed']) {
      assert.equal(result.state.optimization[name].status, 'converged')
      assert.equal(result.state.optimization[name].evaluations, 3)
    }
  })
})
