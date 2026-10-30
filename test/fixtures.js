'use strict'

const radians = degrees => degrees * Math.PI / 180
const target = (degrees, tbs, auxiliary = {}) => ({
  twa: radians(degrees), tbs, vmg: tbs * Math.abs(Math.cos(radians(degrees))), ...auxiliary
})

function fixture() {
  return {
    kind: 'polarSet', schemaVersion: '2.0.0', name: 'Routing reference',
    units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
    symmetry: { portStarboardSymmetric: true },
    best: {
      axes: { tws: [5, 10], twa: [40, 60, 90, 120, 150, 180].map(radians) },
      values: {
        boatSpeedMatrix: [[3, 5, 6, 5.5, 4.5, 3], [4, 6, 8, 7, 6, 4]],
        heelMatrix: [[0.1, 0.2, null, 0.4, null, 0.2], [0.2, 0.4, null, 0.8, null, 0.4]],
        reefMatrix: [[null, 1, 1, 0.8, 0.8, null], [null, 0.8, 0.8, 0.6, 0.6, null]]
      },
      derived: { rows: [
        { tws: 5, beat: target(40, 3, { heel: 0.7, flat: 0.9 }), run: target(150, 4.5) },
        { tws: 10, beat: target(40, 4, { heel: 0.9, flat: 0.7 }), run: target(150, 6) }
      ] }
    },
    waveCorrection: { heights: [
      {
        significantWaveHeight: 1,
        axes: { wavePeriod: [4, 8, 12], waveAngle: [0, 60, 120, 180].map(radians) },
        values: { speedFactorMatrix: [[0, 0.4, 1.2, 1.5], [0.2, 0.6, 1, 1.4], [0.4, 0.8, 1.2, 1.2]] }
      },
      {
        significantWaveHeight: 3,
        axes: { wavePeriod: [6, 10], waveAngle: [20, 90, 160].map(radians) },
        values: { speedFactorMatrix: [[0.1, 0.5, 1.3], [0.3, 0.7, 1.1]] }
      }
    ] }
  }
}

module.exports = { fixture, radians, target }
