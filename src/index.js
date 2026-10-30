'use strict'

const { validatePolarTable, validatePolar } = require('polar-format')
const { bracket, validSeaState, correction, waveFactor, bowSeaState } = require('./waves')

const PINCH_FACTOR = 0.8
const BEAT_ENDPOINT_ANGLE = 25 * Math.PI / 180
const EPSILON = 1e-9
const DEFAULT_PERFORMANCE_FACTOR = 1.0
const AUXILIARIES = ['heel', 'reef', 'flat']
const TARGETS = ['beat', 'run', 'maxSpeed']

function validState(tws, twa = null) {
  return { available: true, tws, twa }
}

function invalidState() {
  return { available: false, reason: 'invalid_input', tws: null, twa: null }
}

function noDataState() {
  return { available: false, reason: 'no_data', tws: null, twa: null }
}

function queryOptions(options, requireTwa) {
  const { tws, twa, performanceFactor = DEFAULT_PERFORMANCE_FACTOR, extrapolate = true } = options || {}
  if (!Number.isFinite(tws) || !Number.isFinite(performanceFactor) || performanceFactor < 0 ||
      (requireTwa && (!Number.isFinite(twa) || Math.abs(twa) > Math.PI))) return null
  return { tws, twa, performanceFactor, extrapolate: extrapolate !== false }
}

function interpolate(a, b, ratio) {
  return a + ratio * (b - a)
}

function roundToTwoDecimals(value) {
  return Math.round(value * 100) / 100
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function findInterpolation(entries, tws) {
  const axis = entries.map(entry => entry.tws)
  const bounded = Math.max(axis[0], Math.min(axis.at(-1), tws))
  const { lower, upper, ratio } = bracket(axis, bounded)
  return { lowerIndex: lower, upperIndex: upper, ratio }
}

function axisState(entries, tws) {
  if (tws < entries[0].tws) return 'below_range'
  if (tws > entries.at(-1).tws) return 'above_range'
  return 'in_range'
}

function prepareAuxiliaries(table, row) {
  return Object.fromEntries(AUXILIARIES.map(name => [
    name,
    table.axes.twa.map((twa, col) => ({ twa, value: table.values[`${name}Matrix`]?.[row]?.[col] }))
      .filter(point => Number.isFinite(point.value))
  ]))
}

function sampleLinear(points, twa) {
  if (!points.length) return null
  const indices = bracket(points.map(point => point.twa), twa)
  if (!indices) return null
  return interpolate(points[indices.lower].value, points[indices.upper].value, indices.ratio)
}

function interpolateAuxiliaries(lower, upper, ratio) {
  return Object.fromEntries(AUXILIARIES.map(name => [
    name, lower[name] === null || upper[name] === null ? null : interpolate(lower[name], upper[name], ratio)
  ]))
}

class Polar {
  static fromTable(table) {
    const validation = validatePolarTable(table)
    if (!validation.valid) {
      throw new TypeError(`Invalid polar table: ${validation.errors.map(error => `${error.path} ${error.message}`).join('; ')}`)
    }
    return new Polar(table)
  }

  static fromPolarSet(set, sailplanId) {
    const validation = validatePolar(set)
    if (!validation.valid || set.schemaVersion !== '2.0.0') {
      const details = validation.errors.map(error => `${error.path} ${error.message}`).join('; ')
      throw new TypeError(`Invalid polar set: ${details || 'expected version 2.0.0 polarSet'}`)
    }
    const table = sailplanId === undefined ? set.best : set.sailplans?.find(plan => plan.id === sailplanId)?.table
    if (!table) throw new TypeError(`Unknown polar sailplan ID: ${String(sailplanId)}`)
    return new Polar(table, set)
  }

  constructor(table, context = table) {
    // Both loaders validate symmetric root context; queries mirror signed TWA.
    this.entries = prepareEntries(table)
    this.auxiliaryEntries = table.axes.tws.map((tws, row) => ({
      tws, ...prepareAuxiliaries(table, row)
    }))
    this.context = { units: context.units, symmetry: context.symmetry, waveCorrection: context.waveCorrection }
    this.context = structuredClone(this.context)
    deepFreeze(this)
  }

  speedAt(options) {
    const input = queryOptions(options, true)
    if (!input || (options?.seaState !== undefined && !validSeaState(options.seaState))) {
      return { value: null, state: invalidState() }
    }
    const wave = options?.seaState === undefined
      ? { value: 1, correction: correction('not_requested') }
      : waveFactor(this.context.waveCorrection, options.seaState)
    const result = this.baselineSpeedAt(input)
    result.state.waveCorrection = wave.correction
    if (result.value !== null) result.value *= wave.value
    return result
  }

  baselineSpeedAt(input) {
    if (this.entries.length === 0) return { value: null, state: noDataState() }

    const { tws, twa, performanceFactor, extrapolate } = input
    const interpolation = this.findTwsInterpolation(tws)
    const state = this.stateAt(tws, twa, extrapolate, interpolation)
    if (state.twa === 'below_range' || state.twa === 'in_irons' || state.twa === 'above_range') {
      return { value: null, state: { ...state, available: false, reason: 'no_data' } }
    }

    const lower = this.entries[interpolation.lowerIndex]
    const upper = this.entries[interpolation.upperIndex]
    const normalizedTwa = Math.abs(twa)
    const lowerSpeed = speedFromEntry(lower, normalizedTwa, extrapolate)
    const upperSpeed = speedFromEntry(upper, normalizedTwa, extrapolate)
    if (lowerSpeed === null || upperSpeed === null) {
      return { value: null, state: { ...state, available: false, reason: 'no_data' } }
    }

    return { value: interpolate(lowerSpeed, upperSpeed, interpolation.ratio) * performanceFactor, state }
  }

  vmgAt(options) {
    const input = queryOptions(options, true)
    if (!input) return { value: null, state: invalidState() }

    const speed = this.speedAt(options)
    return { value: speed.value === null ? null : speed.value * Math.cos(input.twa), state: speed.state }
  }

  targetsAt(options) {
    const input = queryOptions(options, false)
    const { seaState, tack = 'starboard', optimizationBudget = 0 } = options || {}
    if (!input || !['starboard', 'port'].includes(tack) ||
        !Number.isInteger(optimizationBudget) || optimizationBudget < 0 ||
        (seaState !== undefined && !validSeaState(seaState, true))) {
      return { value: null, state: invalidState() }
    }
    if (this.entries.length === 0) return { value: null, state: noDataState() }

    const interpolation = this.findTwsInterpolation(input.tws)
    const lower = this.entries[interpolation.lowerIndex]
    const upper = this.entries[interpolation.upperIndex]
    const scale = input.performanceFactor
    const target = (key) => interpolate(lower[key], upper[key], interpolation.ratio)
    const sideTarget = (name) => {
      const angleKey = `${name}Angle`
      const speedKey = `${name}Speed`
      const vmgKey = `${name}Vmg`
      if (!Number.isFinite(lower[angleKey]) || !Number.isFinite(upper[angleKey])) return null
      return {
        twa: target(angleKey),
        speed: target(speedKey) * scale,
        vmg: target(vmgKey) * scale,
        ...interpolateAuxiliaries(lower.targetAux[name], upper.targetAux[name], interpolation.ratio)
      }
    }

    const value = {
      beat: sideTarget('beat'),
      run: sideTarget('run'),
      maxSpeed: {
        twa: target('maxSpeedAngle'), speed: target('maxSpeed') * scale,
        ...interpolateAuxiliaries(lower.targetAux.maxSpeed, upper.targetAux.maxSpeed, interpolation.ratio)
      }
    }
    const state = validState(this.twsState(input.tws), null)
    state.waveCorrection = {}
    state.optimization = {}
    for (const name of TARGETS) {
      let reason = seaState === undefined ? 'not_requested' : !this.context.waveCorrection ? 'no_model' : 'out_of_range'
      let status = optimizationBudget === 0 ? 'not_requested' : 'not_applicable'
      let evaluations = 0
      if (!value[name]) status = 'unavailable'
      else if (seaState !== undefined && this.context.waveCorrection) {
        if (optimizationBudget > 0) {
          const searched = this.searchTarget(name, value[name], input, seaState, tack, optimizationBudget)
          evaluations = searched.evaluations
          status = searched.status
          if (searched.target) {
            value[name] = searched.target
            reason = null
          }
        } else {
          const wave = waveFactor(this.context.waveCorrection, bowSeaState(seaState, value[name].twa, tack))
          reason = wave.correction.reason
          if (wave.correction.applied) {
            value[name].speed *= wave.value
            if (name !== 'maxSpeed') value[name].vmg = value[name].speed * Math.abs(Math.cos(value[name].twa))
          }
        }
      }
      state.waveCorrection[name] = correction(reason)
      state.optimization[name] = { status, evaluations }
    }
    return { value, state }
  }

  searchTarget(name, baseline, input, seaState, tack, budget) {
    const range = this.rangeAt(input).value
    if (!range) return { target: null, status: 'unavailable', evaluations: 0 }
    const min = name === 'run' ? Math.max(range.minTwa, Math.PI / 2) : range.minTwa
    const max = name === 'beat' ? Math.min(range.maxTwa, Math.PI / 2) : range.maxTwa
    if (min > max) return { target: null, status: 'unavailable', evaluations: 0 }
    let best = null
    let score = -Infinity
    let evaluations = 0
    // Breadth-first interval bisection visits multiple regions before refinement.
    const queue = [[min, max]]
    const seen = new Set()
    const evaluate = twa => {
      if (twa < min || twa > max || seen.has(twa) || evaluations >= budget) return
      seen.add(twa)
      evaluations += 1
      const wave = waveFactor(this.context.waveCorrection, bowSeaState(seaState, twa, tack))
      if (!wave.correction.applied) return
      const speed = this.baselineSpeedAt({ ...input, twa }).value
      if (speed === null) return
      const correctedSpeed = speed * wave.value
      const vmg = correctedSpeed * Math.abs(Math.cos(twa))
      const candidateScore = name === 'maxSpeed' ? correctedSpeed : vmg
      if (candidateScore > score) {
        score = candidateScore
        best = { twa, speed: correctedSpeed, ...(name === 'maxSpeed' ? {} : { vmg }) }
      }
    }
    evaluate(baseline.twa)
    evaluate(min)
    evaluate(max)
    let cursor = 0
    while (evaluations < budget && cursor < queue.length) {
      const [left, right] = queue[cursor++]
      const middle = (left + right) / 2
      evaluate(middle)
      if (right - left > 1e-5 && middle !== left && middle !== right) {
        queue.push([left, middle], [middle, right])
      }
    }
    if (best) {
      Object.assign(best, best.twa === baseline.twa
        ? Object.fromEntries(AUXILIARIES.map(name => [name, baseline[name]]))
        : this.auxiliariesAt(input.tws, best.twa))
    }
    return {
      target: best, evaluations,
      status: !best ? 'not_applicable' : cursor === queue.length ? 'converged' : 'budget_exhausted'
    }
  }

  waveFactorAt(options) {
    if (!validSeaState(options)) return { value: null, state: invalidState() }
    const wave = waveFactor(this.context.waveCorrection, options)
    return { value: wave.value, state: { ...validState(null), waveCorrection: wave.correction } }
  }

  heelAt(options) { return this.auxiliaryAt('heel', options) }
  reefAt(options) { return this.auxiliaryAt('reef', options) }
  flatAt(options) { return this.auxiliaryAt('flat', options) }

  auxiliaryAt(name, options) {
    const input = queryOptions(options, true)
    if (!input) return { value: null, state: invalidState() }
    const { lowerIndex, upperIndex, ratio } = findInterpolation(this.auxiliaryEntries, input.tws)
    const lower = this.auxiliaryEntries[lowerIndex][name]
    const upper = this.auxiliaryEntries[upperIndex][name]
    const twa = Math.abs(input.twa)
    const low = sampleLinear(lower, twa)
    const high = sampleLinear(upper, twa)
    let twaState = 'in_range'
    if (lower.length && upper.length) {
      if (twa < Math.max(lower[0].twa, upper[0].twa)) twaState = 'below_range'
      else if (twa > Math.min(lower.at(-1).twa, upper.at(-1).twa)) twaState = 'above_range'
    }
    const state = validState(axisState(this.auxiliaryEntries, input.tws), twaState)
    if (low === null || high === null) return { value: null, state: { ...state, available: false, reason: 'no_data' } }
    return { value: interpolate(low, high, ratio), state }
  }

  auxiliariesAt(tws, twa) {
    return Object.fromEntries(AUXILIARIES.map(name => [name, this.auxiliaryAt(name, { tws, twa }).value]))
  }

  rangeAt(options) {
    const input = queryOptions(options, false)
    if (!input) return { value: null, state: invalidState() }
    if (this.entries.length === 0) return { value: null, state: noDataState() }

    const interpolation = this.findTwsInterpolation(input.tws)
    const lower = this.entries[interpolation.lowerIndex]
    const upper = this.entries[interpolation.upperIndex]
    const minTwa = Math.max(minTwaForEntry(lower, input.extrapolate), minTwaForEntry(upper, input.extrapolate))
    const maxTwa = Math.min(maxTwaForEntry(lower, input.extrapolate), maxTwaForEntry(upper, input.extrapolate))
    if (minTwa > maxTwa) {
      return { value: null, state: { ...noDataState(), tws: this.twsState(input.tws) } }
    }
    return {
      value: { minTwa, maxTwa },
      state: validState(this.twsState(input.tws), null)
    }
  }

  findTwsInterpolation(tws) {
    return findInterpolation(this.entries, tws)
  }

  twsState(tws) {
    const first = this.entries[1] || this.entries[0]
    const last = this.entries.at(-1)
    if (tws < first.tws) return 'below_range'
    if (tws > last.tws) return 'above_range'
    return 'in_range'
  }

  stateAt(tws, twa, extrapolate = true, interpolation = this.findTwsInterpolation(tws)) {
    if (this.entries.length === 0) return noDataState()

    const normalizedTwa = Math.abs(twa)
    const lower = this.entries[interpolation.lowerIndex]
    const upper = this.entries[interpolation.upperIndex]
    const minTwa = Math.max(minTwaForEntry(lower, extrapolate), minTwaForEntry(upper, extrapolate))
    const maxTwa = Math.min(maxTwaForEntry(lower, extrapolate), maxTwaForEntry(upper, extrapolate))

    if (!extrapolate) {
      let twaState = 'in_range'
      if (normalizedTwa < minTwa) twaState = 'below_range'
      else if (normalizedTwa > maxTwa) twaState = 'above_range'
      return validState(this.twsState(tws), twaState)
    }

    const hasBeat = Number.isFinite(lower.beatAngle) && Number.isFinite(upper.beatAngle)
    const beatAngle = hasBeat ? interpolate(lower.beatAngle, upper.beatAngle, interpolation.ratio) : null
    let twaState = 'in_range'
    const hasPinch = lower.points[0].twa < lower.realPoints[0].twa &&
      upper.points[0].twa < upper.realPoints[0].twa
    if (normalizedTwa < minTwa) twaState = hasPinch ? 'in_irons' : 'below_range'
    else if (hasBeat && normalizedTwa < beatAngle) twaState = 'pinching'
    else {
      const lastTwa = Math.max(lower.points.at(-1).twa, upper.points.at(-1).twa)
      if (normalizedTwa > maxTwa) twaState = 'above_range'
      else if (normalizedTwa > lastTwa) twaState = 'extrapolated'
    }
    return validState(this.twsState(tws), twaState)
  }
}

function prepareEntries(table) {
  const targets = fillDerivedTargets(table.axes.tws, table.derived?.rows || [])
  const entries = table.axes.tws.flatMap((tws, rowIndex) => {
    const axisPoints = table.axes.twa
      .map((twa, colIndex) => ({ twa, speed: table.values.boatSpeedMatrix[rowIndex][colIndex] }))
      .filter(point => Number.isFinite(point.speed))

    const points = axisPoints.slice()
    const sourceRow = table.derived?.rows?.find(row => row.tws === tws)
    const target = {
      beat: targets[rowIndex].beat,
      run: targets[rowIndex].run
    }
    addTarget(points, target.beat)
    addTarget(points, target.run)
    if (!points.length && Number.isFinite(sourceRow?.maxSpeed) && Number.isFinite(sourceRow?.maxSpeedAngle)) {
      points.push({ twa: sourceRow.maxSpeedAngle, speed: sourceRow.maxSpeed })
    }
    if (points.length === 0) return []
    points.sort((a, b) => a.twa - b.twa)
    const derived = deriveTargets(points, target)
    if (Number.isFinite(sourceRow?.maxSpeed) && Number.isFinite(sourceRow?.maxSpeedAngle)) {
      derived.maxSpeed = sourceRow.maxSpeed
      derived.maxSpeedAngle = sourceRow.maxSpeedAngle
    }
    const auxiliaries = prepareAuxiliaries(table, rowIndex)
    const targetAux = Object.fromEntries(TARGETS.map(name => [
      name, Object.fromEntries(AUXILIARIES.map(quantity => [
        quantity, sourceRow?.[name]?.[quantity] ?? sampleLinear(auxiliaries[quantity], derived[`${name}Angle`])
      ]))
    ]))
    const realPoints = points.slice()

    const extended = addRunExtension(axisPoints, addBeatExtension(points, derived), derived)
    const tangents = pchipTangents(extended)
    const realTangents = pchipTangents(realPoints)
    const runFlatten = buildRunFlatten(extended, tangents, derived)

    return [{ tws, points: extended, tangents, realPoints, realTangents, runFlatten, targetAux, ...derived }]
  })

  if (entries.length === 0) return []

  const first = entries[0]
  entries.unshift({
    tws: Math.min(0.0001, first.tws / 2),
    points: first.points.map(point => ({ ...point, speed: 0 })),
    tangents: first.tangents.map(() => 0),
    realPoints: first.realPoints.map(point => ({ ...point, speed: 0 })),
    realTangents: first.realTangents.map(() => 0),
    runFlatten: first.runFlatten ? { ...first.runFlatten, anchorVmg: 0, a: 0, b: 0 } : null,
    beatAngle: first.beatAngle,
    beatSpeed: 0,
    beatVmg: 0,
    runAngle: first.runAngle,
    runSpeed: 0,
    runVmg: 0,
    maxSpeed: 0,
    maxSpeedAngle: first.maxSpeedAngle,
    targetAux: first.targetAux
  })
  return entries.map(entry => Object.freeze({
    ...entry,
    points: Object.freeze(entry.points.map(Object.freeze)),
    realPoints: Object.freeze(entry.realPoints.map(Object.freeze)),
    tangents: Object.freeze(entry.tangents),
    realTangents: Object.freeze(entry.realTangents)
  }))
}

// Prepends a synthetic zero-speed endpoint so the PCHIP curve reaches 25deg on
// the beat side without using the query cutoff to shape the curve.
function addBeatExtension(points, derived) {
  if (points.length < 2) return points
  if (!Number.isFinite(derived.beatAngle) || derived.beatAngle <= BEAT_ENDPOINT_ANGLE) return points
  if (points[0].twa <= BEAT_ENDPOINT_ANGLE + EPSILON) return points
  return [{ twa: BEAT_ENDPOINT_ANGLE, speed: 0 }, ...points]
}

// Extends the run side of the curve with at most one mirrored point beyond the
// deepest known angle (see buildRunFlatten for the quadratic VMG taper to 180deg
// that starts from this extended point list).
function addRunExtension(axisPoints, points, derived) {
  if (!Number.isFinite(derived.runAngle)) return points

  const referenceAngle = findReferenceAngle(axisPoints, derived.runAngle)
  if (referenceAngle === null) return points

  let mirrorAngle = 2 * derived.runAngle - referenceAngle
  if (Math.abs(mirrorAngle - Math.PI) < EPSILON) mirrorAngle = Math.PI // snap float noise onto the exact boundary
  const maxKnownAngle = points.at(-1).twa
  const mirrorCosine = Math.abs(Math.cos(mirrorAngle))
  // Skip the mirror point entirely if its true (uncapped) position is beyond
  // 180deg -- placing it clamped at pi would encode the wrong VMG right at the
  // boundary and short-circuit the smooth taper below.
  if (mirrorAngle > Math.PI || mirrorAngle <= maxKnownAngle + EPSILON || mirrorCosine <= EPSILON) return points

  const reference = axisPoints.find(point => point.twa === referenceAngle)
  const referenceVmg = reference.speed * Math.abs(Math.cos(reference.twa))
  const mirrorSpeed = Math.max(0, referenceVmg / mirrorCosine)
  return [...points, { twa: mirrorAngle, speed: mirrorSpeed }].sort((a, b) => a.twa - b.twa)
}

// Quadratic VMG taper from the deepest known point (mirror point, or the last
// real point if no mirror was added) to zero VMG slope at 180deg. The initial
// slope comes from the PCHIP tangent at that point (dSpeed/dTWA), converted to
// dVMG/dTWA via the product rule so the taper is slope-continuous with the
// interior curve rather than restarting from a separate secant estimate.
function buildRunFlatten(points, tangents, derived) {
  if (!Number.isFinite(derived.runAngle)) return null
  const anchor = points.at(-1)
  if (points.length < 2 || anchor.twa >= Math.PI - EPSILON) return null

  const anchorVmg = anchor.speed * Math.abs(Math.cos(anchor.twa))
  const speedSlope = tangents.at(-1)
  // VMG magnitude = -speed*cos(twa) for twa in (pi/2, pi]; differentiate via the product rule.
  let slope = -speedSlope * Math.cos(anchor.twa) + anchor.speed * Math.sin(anchor.twa)
  slope = Math.min(0, slope) // VMG may never increase
  const distanceToEnd = Math.PI - anchor.twa

  return { anchorTwa: anchor.twa, anchorVmg, a: -slope / (2 * distanceToEnd), b: slope }
}

// Biggest axis-defined TWA (with real data) below the rounded run angle.
function findReferenceAngle(axisPoints, runAngle) {
  const roundedRunDeg = Math.round(runAngle * 180 / Math.PI)
  let best = null
  for (const point of axisPoints) {
    const deg = Math.round(point.twa * 180 / Math.PI)
    if (deg < roundedRunDeg && (best === null || point.twa > best)) best = point.twa
  }
  return best
}

// Fritsch-Carlson monotone cubic Hermite (PCHIP) tangents for a sorted point list.
// Interior tangents use a weighted harmonic mean of the two adjacent secants (zero
// at local extrema, so the curve never overshoots between real points); endpoint
// tangents use the standard one-sided three-point estimate with the same
// shape-preserving clamp.
function pchipTangents(points) {
  const n = points.length
  const tangents = new Array(n).fill(0)
  if (n < 2) return tangents

  const h = []
  const m = []
  for (let i = 0; i < n - 1; i += 1) {
    h.push(points[i + 1].twa - points[i].twa)
    m.push((points[i + 1].speed - points[i].speed) / h[i])
  }

  if (n === 2) {
    tangents[0] = m[0]
    tangents[1] = m[0]
    return tangents
  }

  for (let i = 1; i < n - 1; i += 1) {
    if (m[i - 1] === 0 || m[i] === 0 || (m[i - 1] > 0) !== (m[i] > 0)) {
      tangents[i] = 0
    } else {
      const w1 = 2 * h[i] + h[i - 1]
      const w2 = h[i] + 2 * h[i - 1]
      tangents[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i])
    }
  }
  tangents[0] = pchipEndpointTangent(h[0], h[1], m[0], m[1])
  tangents[n - 1] = pchipEndpointTangent(h[n - 2], h[n - 3], m[n - 2], m[n - 3])
  return tangents
}

function pchipEndpointTangent(h0, h1, m0, m1) {
  let tangent = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1)
  if (tangent !== 0 && m0 !== 0 && (tangent > 0) !== (m0 > 0)) tangent = 0
  else if (m0 !== 0 && m1 !== 0 && (m0 > 0) !== (m1 > 0) && Math.abs(tangent) > Math.abs(3 * m0)) tangent = 3 * m0
  return tangent
}

// Evaluates the monotone cubic Hermite curve at twa; null below the first point.
function evaluatePchip(points, tangents, twa) {
  if (twa < points[0].twa) return null
  if (points.length === 1) return twa === points[0].twa ? points[0].speed : null

  let index = 0
  for (let i = 0; i < points.length - 1; i += 1) {
    if (points[i].twa <= twa) index = i
  }
  if (index === points.length - 1) return points[index].speed

  const p0 = points[index]
  const p1 = points[index + 1]
  const h = p1.twa - p0.twa
  const t = (twa - p0.twa) / h
  const t2 = t * t
  const t3 = t2 * t
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  return Math.max(0, h00 * p0.speed + h10 * h * tangents[index] + h01 * p1.speed + h11 * h * tangents[index + 1])
}

function addTarget(points, target) {
  if (!target) return
  const index = points.findIndex(point => point.twa === target.twa)
  const point = { twa: target.twa, speed: target.tbs }
  if (index >= 0) points[index] = point
  else points.push(point)
}

function deriveTargets(points, target) {
  const best = (predicate) => points.filter(predicate).reduce((result, point) =>
    !result || point.speed * Math.abs(Math.cos(point.twa)) > result.speed * Math.abs(Math.cos(result.twa)) ? point : result, null)
  const beat = target.beat || best(point => point.twa < Math.PI / 2)
  const run = target.run || best(point => point.twa >= Math.PI / 2)
  const max = points.reduce((result, point) => point.speed > result.speed ? point : result, points[0])
  return {
    beatAngle: beat?.twa ?? null, beatSpeed: beat ? beat.tbs ?? beat.speed : null,
    beatVmg: beat ? roundToTwoDecimals(beat.vmg ?? beat.speed * Math.abs(Math.cos(beat.twa))) : null,
    runAngle: run?.twa ?? null, runSpeed: run ? run.tbs ?? run.speed : null,
    runVmg: run ? roundToTwoDecimals(run.vmg ?? run.speed * Math.abs(Math.cos(run.twa))) : null,
    maxSpeed: max.speed, maxSpeedAngle: max.twa
  }
}

function speedFromEntry(entry, twa, extrapolate) {
  const points = extrapolate ? entry.points : entry.realPoints
  const tangents = extrapolate ? entry.tangents : entry.realTangents
  const last = points.at(-1)
  if (twa > last.twa) {
    if (!extrapolate || !entry.runFlatten) return null
    const x = twa - entry.runFlatten.anchorTwa
    const vmg = Math.min(entry.runFlatten.anchorVmg, entry.runFlatten.anchorVmg + entry.runFlatten.b * x + entry.runFlatten.a * x * x)
    const cosine = Math.abs(Math.cos(twa)) // vmg is a magnitude (see buildRunFlatten); keep the conversion sign-consistent
    return cosine < EPSILON ? null : Math.max(0, vmg / cosine)
  }
  return evaluatePchip(points, tangents, twa)
}

function minTwaForEntry(entry, extrapolate) {
  if (!extrapolate) return entry.realPoints[0].twa
  if (entry.points[0].twa === entry.realPoints[0].twa) return entry.realPoints[0].twa
  return Number.isFinite(entry.beatAngle)
    ? Math.min(entry.realPoints[0].twa, BEAT_ENDPOINT_ANGLE + PINCH_FACTOR * (entry.beatAngle - BEAT_ENDPOINT_ANGLE))
    : entry.points[0].twa
}

function maxTwaForEntry(entry, extrapolate) {
  if (!extrapolate) return entry.realPoints.at(-1).twa
  return entry.runFlatten ? Math.PI : entry.points.at(-1).twa
}

function fillDerivedTargets(twsAxis, rows) {
  const targets = twsAxis.map(tws => {
    const row = rows.find(candidate => Math.abs(candidate.tws - tws) < 1e-6)
    return {
      beat: validTarget(row?.beat) ? { ...row.beat } : null,
      run: validTarget(row?.run) ? { ...row.run } : null
    }
  })
  for (const key of ['beat', 'run']) {
    for (let index = 0; index < targets.length; index += 1) {
      if (targets[index][key]) continue
      const lower = findTarget(targets, key, index, -1)
      const upper = findTarget(targets, key, index, 1)
      if (lower >= 0 && upper >= 0) {
        const ratio = (twsAxis[index] - twsAxis[lower]) / (twsAxis[upper] - twsAxis[lower])
        const low = targets[lower][key]
        const high = targets[upper][key]
        const twa = interpolate(low.twa, high.twa, ratio)
        const tbs = interpolate(low.tbs, high.tbs, ratio)
        targets[index][key] = { twa, tbs, vmg: tbs * Math.abs(Math.cos(twa)) }
      } else if (lower >= 0) targets[index][key] = { ...targets[lower][key] }
      else if (upper >= 0) targets[index][key] = { ...targets[upper][key] }
    }
  }
  return targets
}

function validTarget(target) {
  return Number.isFinite(target?.twa) && Number.isFinite(target?.tbs)
}

function findTarget(targets, key, from, direction) {
  for (let index = from + direction; index >= 0 && index < targets.length; index += direction) {
    if (targets[index][key]) return index
  }
  return -1
}

module.exports = { Polar }