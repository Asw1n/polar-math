'use strict'

const { validatePolarTable } = require('polar-format')

const PINCH_FACTOR = 0.9
const PINCH_ANGLE = 25 * Math.PI / 180
const EPSILON = 1e-9

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
  const { tws, twa, performanceFactor = 1, extrapolate = true } = options || {}
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

class Polar {
  static fromTable(table) {
    const validation = validatePolarTable(table)
    if (!validation.valid) {
      throw new TypeError(`Invalid polar table: ${validation.errors.map(error => `${error.path} ${error.message}`).join('; ')}`)
    }
    return new Polar(table)
  }

  constructor(table) {
    // validatePolarTable requires symmetry.portStarboardSymmetric === true; queries below rely on that
    // and always mirror speed across the beam (Math.abs(twa)). There is no asymmetric-table support yet.
    this.entries = prepareEntries(table)
    Object.freeze(this.entries)
  }

  speedAt(options) {
    const input = queryOptions(options, true)
    if (!input) return { value: null, state: invalidState() }
    if (this.entries.length === 0) return { value: null, state: noDataState() }

    const { tws, twa, performanceFactor, extrapolate } = input
    const interpolation = this.findTwsInterpolation(tws)
    const state = this.stateAt(tws, twa, extrapolate, interpolation)
    if (state.twa === 'below_range' || state.twa === 'in_irons' || state.twa === 'above_range') {
      return { value: null, state }
    }

    const lower = this.entries[interpolation.lowerIndex]
    const upper = this.entries[interpolation.upperIndex]
    const normalizedTwa = Math.abs(twa)
    const lowerSpeed = speedFromEntry(lower, normalizedTwa, extrapolate)
    const upperSpeed = speedFromEntry(upper, normalizedTwa, extrapolate)
    if (lowerSpeed === null || upperSpeed === null) return { value: null, state }

    return { value: interpolate(lowerSpeed, upperSpeed, interpolation.ratio) * performanceFactor, state }
  }

  vmgAt(options) {
    const input = queryOptions(options, true)
    if (!input) return { value: null, state: invalidState() }

    const speed = this.speedAt(input)
    return { value: speed.value === null ? null : speed.value * Math.cos(input.twa), state: speed.state }
  }

  targetsAt(options) {
    const input = queryOptions(options, false)
    if (!input) return { value: null, state: invalidState() }
    if (this.entries.length === 0) return { value: null, state: noDataState() }

    const interpolation = this.findTwsInterpolation(input.tws)
    const lower = this.entries[interpolation.lowerIndex]
    const upper = this.entries[interpolation.upperIndex]
    const scale = input.performanceFactor
    const target = (key) => interpolate(lower[key], upper[key], interpolation.ratio)
    const maxSpeed = target('maxSpeed') * scale
    const sideTarget = (name) => {
      const angleKey = `${name}Angle`
      const speedKey = `${name}Speed`
      const vmgKey = `${name}Vmg`
      if (!Number.isFinite(lower[angleKey]) || !Number.isFinite(upper[angleKey])) return null
      return {
        twa: target(angleKey),
        speed: target(speedKey) * scale,
        vmg: target(vmgKey) * scale
      }
    }

    return {
      value: {
        beat: sideTarget('beat'),
        run: sideTarget('run'),
        maxSpeed: { twa: target('maxSpeedAngle'), speed: maxSpeed }
      },
      state: validState(this.twsState(input.tws), null)
    }
  }

  rangeAt(options) {
    const input = queryOptions(options, false)
    if (!input) return { value: null, state: invalidState() }
    if (this.entries.length === 0) return { value: null, state: noDataState() }

    const interpolation = this.findTwsInterpolation(input.tws)
    const lower = this.entries[interpolation.lowerIndex]
    const upper = this.entries[interpolation.upperIndex]
    return {
      value: {
        minTwa: interpolate(minTwaForEntry(lower, input.extrapolate), minTwaForEntry(upper, input.extrapolate), interpolation.ratio),
        maxTwa: interpolate(maxTwaForEntry(lower, input.extrapolate), maxTwaForEntry(upper, input.extrapolate), interpolation.ratio)
      },
      state: validState(this.twsState(input.tws), null)
    }
  }

  findTwsInterpolation(tws) {
    let lowerIndex = -1
    let upperIndex = -1
    for (let index = 0; index < this.entries.length; index += 1) {
      if (this.entries[index].tws <= tws) lowerIndex = index
      if (this.entries[index].tws >= tws && upperIndex === -1) upperIndex = index
    }
    if (lowerIndex === -1) return { lowerIndex: 0, upperIndex: 0, ratio: 0 }
    if (upperIndex === -1) {
      const lastIndex = this.entries.length - 1
      return { lowerIndex: lastIndex, upperIndex: lastIndex, ratio: 0 }
    }
    if (lowerIndex === upperIndex) return { lowerIndex, upperIndex, ratio: 0 }
    return {
      lowerIndex,
      upperIndex,
      ratio: (tws - this.entries[lowerIndex].tws) / (this.entries[upperIndex].tws - this.entries[lowerIndex].tws)
    }
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
    const minTwa = interpolate(minTwaForEntry(lower, extrapolate), minTwaForEntry(upper, extrapolate), interpolation.ratio)
    const maxTwa = interpolate(maxTwaForEntry(lower, extrapolate), maxTwaForEntry(upper, extrapolate), interpolation.ratio)

    if (!extrapolate) {
      let twaState = 'in_range'
      if (normalizedTwa < minTwa) twaState = 'below_range'
      else if (normalizedTwa > maxTwa) twaState = 'above_range'
      return validState(this.twsState(tws), twaState)
    }

    const hasBeat = Number.isFinite(lower.beatAngle) && Number.isFinite(upper.beatAngle)
    const beatAngle = hasBeat ? interpolate(lower.beatAngle, upper.beatAngle, interpolation.ratio) : null
    let twaState = 'in_range'
    if (normalizedTwa < minTwa) twaState = hasBeat ? 'in_irons' : 'below_range'
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
      .filter(point => point.speed > 0)
    if (axisPoints.length === 0) return []

    const points = axisPoints.slice()
    const target = {
      beat: points.some(point => point.twa < Math.PI / 2) ? targets[rowIndex].beat : null,
      run: points.some(point => point.twa >= Math.PI / 2) ? targets[rowIndex].run : null
    }
    addTarget(points, target.beat)
    addTarget(points, target.run)
    points.sort((a, b) => a.twa - b.twa)
    const derived = deriveTargets(points, target)
    const { points: extendedPoints, runFlatten } = addRunExtension(axisPoints, points, derived)
    return [{ tws, points: extendedPoints, realPoints: points, runFlatten, ...derived }]
  })

  if (entries.length === 0) return []

  const first = entries[0]
  entries.unshift({
    tws: 0.0001,
    points: first.points.map(point => ({ ...point, speed: 0 })),
    realPoints: first.realPoints.map(point => ({ ...point, speed: 0 })),
    runFlatten: first.runFlatten ? { ...first.runFlatten, anchorVmg: 0, a: 0, b: 0 } : null,
    beatAngle: first.beatAngle,
    beatSpeed: 0,
    beatVmg: 0,
    runAngle: first.runAngle,
    runSpeed: 0,
    runVmg: 0,
    maxSpeed: 0,
    maxSpeedAngle: first.maxSpeedAngle
  })
  entries.forEach(addExtrapolation)
  return entries.map(entry => Object.freeze({
    ...entry,
    points: Object.freeze(entry.points.map(Object.freeze)),
    realPoints: Object.freeze(entry.realPoints.map(Object.freeze))
  }))
}

// Extends the run side of the curve with at most one mirrored point beyond the
// deepest known angle, then a quadratic VMG taper to zero slope at 180deg.
// See run-extrapolation design discussion (mirror point + VMG flattening) for rationale.
function addRunExtension(axisPoints, points, derived) {
  if (!Number.isFinite(derived.runAngle)) return { points, runFlatten: null }

  let extended = points
  const referenceAngle = findReferenceAngle(axisPoints, derived.runAngle)
  if (referenceAngle !== null) {
    let mirrorAngle = 2 * derived.runAngle - referenceAngle
    if (Math.abs(mirrorAngle - Math.PI) < EPSILON) mirrorAngle = Math.PI // snap float noise onto the exact boundary
    const maxKnownAngle = points.at(-1).twa
    const mirrorCosine = Math.abs(Math.cos(mirrorAngle))
    // Skip the mirror point entirely if its true (uncapped) position is beyond
    // 180deg -- placing it clamped at pi would encode the wrong VMG right at the
    // boundary and short-circuit the smooth taper below.
    if (mirrorAngle <= Math.PI && mirrorAngle > maxKnownAngle + EPSILON && mirrorCosine > EPSILON) {
      const reference = axisPoints.find(point => point.twa === referenceAngle)
      const referenceVmg = reference.speed * Math.abs(Math.cos(reference.twa))
      const mirrorSpeed = Math.max(0, referenceVmg / mirrorCosine)
      extended = [...points, { twa: mirrorAngle, speed: mirrorSpeed }].sort((a, b) => a.twa - b.twa)
    }
  }

  const anchor = extended.at(-1)
  const previous = extended.at(-2)
  if (!previous || anchor.twa >= Math.PI - EPSILON) return { points: extended, runFlatten: null }

  const anchorVmg = anchor.speed * Math.abs(Math.cos(anchor.twa))
  const previousVmg = previous.speed * Math.abs(Math.cos(previous.twa))
  const distanceToEnd = Math.PI - anchor.twa
  const slope = Math.min(0, (anchorVmg - previousVmg) / (anchor.twa - previous.twa)) // VMG may never increase

  return {
    points: extended,
    runFlatten: { anchorTwa: anchor.twa, anchorVmg, a: -slope / (2 * distanceToEnd), b: slope }
  }
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

function addExtrapolation(entry) {
  const beatIndex = entry.points.findIndex(point => point.twa === entry.beatAngle)
  if (entry.beatAngle > PINCH_ANGLE && beatIndex >= 0) {
    const beat = entry.points[beatIndex]
    const next = entry.points[beatIndex + 1]
    if (next?.twa < Math.PI / 2) {
      const slope = (next.speed - beat.speed) / (next.twa - beat.twa)
      const distance = entry.beatAngle - PINCH_ANGLE
      const a = (slope * distance - beat.speed) / (distance * distance)
      entry.beatExtrap = { a, b: slope - 2 * a * distance }
    }
  }
}

function speedFromEntry(entry, twa, extrapolate) {
  if (extrapolate && Number.isFinite(entry.beatAngle) && twa < entry.beatAngle) {
    if (!entry.beatExtrap || twa <= PINCH_ANGLE) return 0
    const distance = twa - PINCH_ANGLE
    return Math.max(0, entry.beatExtrap.a * distance * distance + entry.beatExtrap.b * distance)
  }
  const points = extrapolate ? entry.points : entry.realPoints
  const last = points.at(-1)
  if (twa > last.twa) {
    if (!extrapolate || !entry.runFlatten) return null
    const x = twa - entry.runFlatten.anchorTwa
    const vmg = Math.min(entry.runFlatten.anchorVmg, entry.runFlatten.anchorVmg + entry.runFlatten.b * x + entry.runFlatten.a * x * x)
    const cosine = Math.abs(Math.cos(twa)) // vmg is a magnitude (see addRunExtension); keep the conversion sign-consistent
    return cosine < EPSILON ? null : Math.max(0, vmg / cosine)
  }
  let lower = -1
  let upper = -1
  for (let index = 0; index < points.length; index += 1) {
    if (points[index].twa <= twa) lower = index
    if (points[index].twa >= twa && upper === -1) upper = index
  }
  if (lower === -1) return null
  if (upper === -1 || lower === upper) return points[lower].speed
  const low = points[lower]
  const high = points[upper]
  return interpolate(low.speed, high.speed, (twa - low.twa) / (high.twa - low.twa))
}

function minTwaForEntry(entry, extrapolate) {
  if (!extrapolate) return entry.realPoints[0].twa
  return entry.beatExtrap ? PINCH_FACTOR * entry.beatAngle : entry.points[0].twa
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