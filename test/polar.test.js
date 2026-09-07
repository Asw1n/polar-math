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
})