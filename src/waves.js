'use strict'

function interpolate(a, b, ratio) {
  return a + (b - a) * ratio
}

function bracket(axis, value) {
  if (value < axis[0] || value > axis.at(-1)) return null
  const upper = axis.findIndex(item => item >= value)
  if (axis[upper] === value) return { lower: upper, upper, ratio: 0 }
  const lower = upper - 1
  return { lower, upper, ratio: (value - axis[lower]) / (axis[upper] - axis[lower]) }
}

function validSeaState(seaState, windRelative = false) {
  if (!seaState || typeof seaState !== 'object' || Array.isArray(seaState)) return false
  const { significantWaveHeight: height, wavePeriod: period } = seaState
  const angle = windRelative ? seaState.waveDirectionRelativeToWind : seaState.waveAngle
  return Number.isFinite(height) && height >= 0 && Number.isFinite(period) && period > 0 &&
    Number.isFinite(angle) && angle >= (windRelative ? -Math.PI : 0) && angle <= Math.PI
}

function correction(reason = null) {
  return { applied: reason === null, reason }
}

function waveFactor(model, seaState) {
  if (!model) return { value: 1, correction: correction('no_model') }
  const { significantWaveHeight, wavePeriod, waveAngle } = seaState
  const heights = bracket(model.heights.map(layer => layer.significantWaveHeight), significantWaveHeight)
  if (!heights) return { value: 1, correction: correction('out_of_range') }
  function atLayer(layer) {
    const periods = bracket(layer.axes.wavePeriod, wavePeriod)
    const angles = bracket(layer.axes.waveAngle, waveAngle)
    if (!periods || !angles) return null
    const atPeriod = index => {
      const row = layer.values.speedFactorMatrix[index]
      return interpolate(row[angles.lower], row[angles.upper], angles.ratio)
    }
    return interpolate(atPeriod(periods.lower), atPeriod(periods.upper), periods.ratio)
  }
  const lower = atLayer(model.heights[heights.lower])
  const upper = heights.lower === heights.upper ? lower : atLayer(model.heights[heights.upper])
  if (lower === null || upper === null) return { value: 1, correction: correction('out_of_range') }
  return { value: interpolate(lower, upper, heights.ratio), correction: correction() }
}

function bowSeaState(seaState, twa, tack) {
  const direction = seaState.waveDirectionRelativeToWind + (tack === 'port' ? -twa : twa)
  const magnitude = Math.abs(direction)
  return { ...seaState, waveAngle: magnitude > Math.PI ? 2 * Math.PI - magnitude : magnitude }
}

module.exports = { bracket, validSeaState, correction, waveFactor, bowSeaState }
