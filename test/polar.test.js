'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('node:test')
const { Polar } = require('../src')

const KNOTS = 1 / 1.94384
const radians = degrees => degrees * Math.PI / 180
const target = (degrees, knots) => {
  const twa = radians(degrees)
  const tbs = knots * KNOTS
  return { twa, tbs, vmg: tbs * Math.abs(Math.cos(twa)) }
}

const TABLE = {
  kind: 'polarTable', schemaVersion: '1.0.0', name: 'Reference Polar',
  units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
  symmetry: { portStarboardSymmetric: true },
  axes: { tws: [4, 12, 24].map(knots => knots * KNOTS), twa: [52, 60, 75, 90, 110, 120, 135, 150].map(radians) },
  values: { boatSpeedMatrix: [
    [3.66, 3.88, 4, 3.9, 3.7, 3.54, 3.12, 2.56],
    [6.42, 6.58, 6.72, 6.82, 6.89, 6.83, 6.62, 6.25],
    [6.69, 6.91, 7.27, 7.61, 8.04, 8.44, 8.54, 8.18]
  ].map(row => row.map(knots => knots * KNOTS)) },
  derived: { rows: [
    { tws: 4 * KNOTS, beat: target(43.2, 3.24), run: target(147.5, 2.63) },
    { tws: 12 * KNOTS, beat: target(39.6, 5.84), run: target(162.4, 5.83) },
    { tws: 24 * KNOTS, beat: target(40.6, 6.11), run: target(178.6, 7.63) }
  ] }
}

const polar = Polar.fromTable(TABLE)
const closeTo = (actual, expected, tolerance = 1e-6) => Math.abs(actual - expected) <= tolerance
const sparseTable = (speeds, twa = [40, 60, 80, 100, 120, 150, 180]) => ({
  kind: 'polarTable', schemaVersion: '1.0.0', name: 'Sparse Polar',
  units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
  symmetry: { portStarboardSymmetric: true },
  axes: { tws: [10 * KNOTS], twa: twa.map(radians) },
  values: { boatSpeedMatrix: [speeds.map(knots => knots * KNOTS)] }
})

describe('Polar', () => {
  it('rejects an invalid canonical polar table when preparing it', () => {
    assert.throws(() => Polar.fromTable({}), /Invalid polar table/)
  })

  it('interpolates speed and returns its range state', () => {
    const result = polar.speedAt({ tws: 12 * KNOTS, twa: radians(90) })
    assert.ok(closeTo(result.value, 6.82 * KNOTS))
    assert.deepEqual(result.state, { available: true, tws: 'in_range', twa: 'in_range' })
  })

  it('keeps port and starboard speed symmetric', () => {
    const port = polar.speedAt({ tws: 12 * KNOTS, twa: radians(-90) })
    const starboard = polar.speedAt({ tws: 12 * KNOTS, twa: radians(90) })
    assert.ok(closeTo(port.value, starboard.value))
  })

  it('returns null and in-irons state below the pinch boundary', () => {
    const result = polar.speedAt({ tws: 12 * KNOTS, twa: radians(10) })
    assert.equal(result.value, null)
    assert.equal(result.state.twa, 'in_irons')
  })

  it('returns a positive interpolated speed in the pinching zone', () => {
    const beat = polar.targetsAt({ tws: 12 * KNOTS }).value.beat
    const result = polar.speedAt({ tws: 12 * KNOTS, twa: 0.95 * beat.twa })
    assert.ok(result.value > 0 && result.value < beat.speed)
    assert.equal(result.state.twa, 'pinching')
  })

  it('returns a signed VMG with the same state as speed', () => {
    const result = polar.vmgAt({ tws: 12 * KNOTS, twa: radians(60) })
    assert.ok(closeTo(result.value, 6.58 * KNOTS * Math.cos(radians(60))))
    assert.equal(result.state.twa, 'in_range')
  })

  it('returns all interpolated targets and a TWS-only state', () => {
    const result = polar.targetsAt({ tws: 12 * KNOTS })
    assert.ok(closeTo(result.value.beat.twa, radians(39.6)))
    assert.ok(closeTo(result.value.run.speed, 5.83 * KNOTS))
    assert.equal(result.state.twa, null)
  })

  it('applies the explicit performance factor to all speed values', () => {
    const base = polar.speedAt({ tws: 12 * KNOTS, twa: radians(90) })
    const adjusted = polar.speedAt({ tws: 12 * KNOTS, twa: radians(90), performanceFactor: 0.9 })
    assert.ok(closeTo(adjusted.value, base.value * 0.9))
    assert.ok(closeTo(polar.targetsAt({ tws: 12 * KNOTS, performanceFactor: 0.9 }).value.beat.speed, 5.84 * KNOTS * 0.9))
  })

  it('defaults the performance factor to 1.0', () => {
    const omitted = polar.speedAt({ tws: 12 * KNOTS, twa: radians(90) })
    const explicit = polar.speedAt({ tws: 12 * KNOTS, twa: radians(90), performanceFactor: 1.0 })
    assert.equal(omitted.value, explicit.value)
  })

  it('returns unavailable state for invalid numeric query input', () => {
    const result = polar.vmgAt({ tws: NaN, twa: radians(60) })
    assert.deepEqual(result, { value: null, state: { available: false, reason: 'invalid_input', tws: null, twa: null } })
  })

  it('returns the inclusive valid angle range for a wind speed', () => {
    const result = polar.rangeAt({ tws: 12 * KNOTS })
    const inside = polar.speedAt({ tws: 12 * KNOTS, twa: result.value.minTwa })
    const outside = polar.speedAt({ tws: 12 * KNOTS, twa: result.value.minTwa - 0.001 })
    const atMax = polar.speedAt({ tws: 12 * KNOTS, twa: result.value.maxTwa })
    assert.ok(inside.value !== null)
    assert.equal(outside.value, null)
    assert.ok(atMax.value !== null)
    assert.equal(result.state.twa, null)
  })

  it('supports a row with only reaching and downwind positive speeds', () => {
    const sparse = Polar.fromTable(sparseTable([0, 0, 0, 6, 7, 6.5, 5]))
    const range = sparse.rangeAt({ tws: 10 * KNOTS })
    const targets = sparse.targetsAt({ tws: 10 * KNOTS })
    const inside = sparse.speedAt({ tws: 10 * KNOTS, twa: radians(110) })
    const outside = sparse.speedAt({ tws: 10 * KNOTS, twa: radians(80) })

    assert.ok(closeTo(range.value.minTwa, radians(100)))
    assert.ok(closeTo(range.value.maxTwa, Math.PI))
    assert.equal(targets.value.beat, null)
    assert.ok(targets.value.run)
    assert.ok(targets.value.maxSpeed.speed > 0)
    assert.ok(Number.isFinite(inside.value) && inside.value > 0)
    assert.equal(outside.value, null)
    assert.equal(outside.state.twa, 'below_range')
  })

  it('supports a row with only upwind positive speeds', () => {
    const sparse = Polar.fromTable(sparseTable([4, 5, 5.5, 0, 0, 0, 0]))
    const range = sparse.rangeAt({ tws: 10 * KNOTS })
    const targets = sparse.targetsAt({ tws: 10 * KNOTS })
    const inside = sparse.speedAt({ tws: 10 * KNOTS, twa: radians(70) })

    assert.ok(targets.value.beat)
    assert.equal(targets.value.run, null)
    assert.ok(closeTo(range.value.maxTwa, radians(80)))
    assert.ok(Number.isFinite(inside.value) && inside.value > 0)
  })

  it('does not extrapolate a lone positive point', () => {
    const sparse = Polar.fromTable(sparseTable([0, 0, 0, 6, 0, 0, 0]))
    const range = sparse.rangeAt({ tws: 10 * KNOTS })

    assert.ok(closeTo(range.value.minTwa, radians(100)))
    assert.ok(closeTo(range.value.maxTwa, radians(100)))
    assert.ok(sparse.speedAt({ tws: 10 * KNOTS, twa: radians(100) }).value > 0)
    assert.equal(sparse.speedAt({ tws: 10 * KNOTS, twa: radians(110) }).value, null)
  })

  it('skips empty rows while retaining sane interpolation and TWS state', () => {
    const table = sparseTable([4, 5, 5.5, 5, 4.5, 4, 3])
    table.axes.tws = [10 * KNOTS, 20 * KNOTS, 30 * KNOTS]
    table.values.boatSpeedMatrix = [
      [4, 5, 5.5, 5, 4.5, 4, 3].map(knots => knots * KNOTS),
      [0, 0, 0, 0, 0, 0, 0],
      [6, 7, 7.5, 7, 6.5, 6, 5].map(knots => knots * KNOTS)
    ]
    const sparse = Polar.fromTable(table)
    const result = sparse.speedAt({ tws: 20 * KNOTS, twa: radians(80) })

    assert.ok(Number.isFinite(result.value) && result.value > 0)
    assert.equal(result.state.tws, 'in_range')
  })

  it('returns a deliberate unavailable state when every row is empty', () => {
    const sparse = Polar.fromTable(sparseTable([0, 0, 0, 0, 0, 0, 0]))

    assert.deepEqual(sparse.speedAt({ tws: 10 * KNOTS, twa: radians(100) }), {
      value: null,
      state: { available: false, reason: 'no_data', tws: null, twa: null }
    })
    assert.deepEqual(sparse.targetsAt({ tws: 10 * KNOTS }), {
      value: null,
      state: { available: false, reason: 'no_data', tws: null, twa: null }
    })
  })

  describe('run-side (gybe) extrapolation beyond the deepest known angle', () => {
    const gybeTable = (twa = [100, 120, 140], speeds = [6, 7, 6.8]) => sparseTable(speeds, twa)

    it('extrapolates to 180deg with monotonically non-increasing VMG', () => {
      const sparse = Polar.fromTable(gybeTable())
      const range = sparse.rangeAt({ tws: 10 * KNOTS })
      assert.ok(closeTo(range.value.maxTwa, Math.PI))

      const vmgAt = (deg) => sparse.vmgAt({ tws: 10 * KNOTS, twa: radians(deg) }).value
      const vmg140 = Math.abs(vmgAt(140))
      const vmg160 = Math.abs(vmgAt(160))
      const vmg180 = Math.abs(vmgAt(180))
      assert.ok(vmg160 > 0 && vmg160 <= vmg140)
      assert.ok(vmg180 > 0 && vmg180 <= vmg160)
      assert.ok(sparse.speedAt({ tws: 10 * KNOTS, twa: radians(160) }).value > 0)
      assert.ok(sparse.speedAt({ tws: 10 * KNOTS, twa: radians(180) }).value > 0)
    })

    it('does not extrapolate beyond real data when the axis already reaches 180deg', () => {
      const sparse = Polar.fromTable(gybeTable([100, 120, 140, 180], [6, 7, 6.8, 6.8]))
      const range = sparse.rangeAt({ tws: 10 * KNOTS })
      assert.ok(closeTo(range.value.maxTwa, Math.PI))
      // real datapoint at 180deg is used as-is, not overridden by a mirrored value
      assert.ok(closeTo(sparse.speedAt({ tws: 10 * KNOTS, twa: radians(180) }).value, 6.8 * KNOTS))
    })

    it('does not throw for a single positive point already at 180deg', () => {
      const sparse = Polar.fromTable(sparseTable([0, 0, 0, 0, 0, 0, 5]))
      const range = sparse.rangeAt({ tws: 10 * KNOTS })
      assert.ok(closeTo(range.value.maxTwa, Math.PI))
      assert.ok(closeTo(sparse.speedAt({ tws: 10 * KNOTS, twa: radians(180) }).value, 5 * KNOTS))
    })
  })

  describe('extrapolate: false opts out of both beat pinch and run extension', () => {
    it('reports the real (unextrapolated) TWA range', () => {
      const extrapolated = polar.rangeAt({ tws: 12 * KNOTS })
      const real = polar.rangeAt({ tws: 12 * KNOTS, extrapolate: false })
      assert.ok(real.value.minTwa > extrapolated.value.minTwa)
      assert.ok(real.value.maxTwa < extrapolated.value.maxTwa)
      // TABLE's tws=12 row has a derived beat target (39.6deg) below the axis's smallest angle (52deg)
      assert.ok(closeTo(real.value.minTwa, radians(39.6)))
    })

    it('returns null beyond the last real datapoint on both sides', () => {
      const beat = polar.targetsAt({ tws: 12 * KNOTS }).value.beat
      const pinching = polar.speedAt({ tws: 12 * KNOTS, twa: 0.95 * beat.twa, extrapolate: false })
      assert.equal(pinching.value, null)
      assert.equal(pinching.state.twa, 'below_range')

      const beyondLast = polar.speedAt({ tws: 12 * KNOTS, twa: radians(170), extrapolate: false })
      assert.equal(beyondLast.value, null)
      assert.equal(beyondLast.state.twa, 'above_range')
    })

    it('still returns real interpolated values within the measured range', () => {
      const result = polar.speedAt({ tws: 12 * KNOTS, twa: radians(90), extrapolate: false })
      assert.ok(closeTo(result.value, 6.82 * KNOTS))
      assert.equal(result.state.twa, 'in_range')
    })

    it('defaults to extrapolate: true when the option is omitted', () => {
      const withOption = polar.rangeAt({ tws: 12 * KNOTS, extrapolate: true })
      const withoutOption = polar.rangeAt({ tws: 12 * KNOTS })
      assert.deepEqual(withoutOption.value, withOption.value)
    })
  })
})