# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- `Polar.fromPolarSet(set, sailplanId?)` prepares one v2 best/sailplan table with
  immutable shared root context; v1 `fromTable` remains supported.
- Linear, nullable `heelAt`, `reefAt`, `flatAt` queries and auxiliary target
  fields with supplied-target precedence and matrix fallback.
- Layered `waveFactorAt`, optional complete sea states for speed/VMG/targets,
  explicit per-scalar/per-target correction status, and tack-aware targets.
- Independently budgeted, deterministic multi-region corrected target searches,
  per-target effort/status, and reproducible routing benchmarks.
- Agreed v2 API specification, implementation documentation and regression tests.

### Changed

- Require published `polar-format ^2.0.0` for v1/v2 schema and semantic validation.
- Skip interior null speed samples, trim null edges, preserve exact/lone samples
  and treat numeric zero as real speed in both loaders (not missing data).
- Between-row ranges describe common speed coverage; unavailable scalar values
  consistently report `available: false`. Pinch extensions never hide real samples.
- Preserve stored maximum-speed/angle pairs as well as existing beat/run inputs.

## 1.1.1 - 2026-09-15

### Fixed

- Defined the beat-side pinch cutoff (reported as `rangeAt`'s `minTwa`) relative to the 25° curve
  endpoint rather than the query cutoff itself, so the cutoff no longer shapes the PCHIP curve it is
  derived from.

## 1.1.0 - 2026-09-10

### Added

- `extrapolate` option (default `true`) on `speedAt`, `vmgAt`, and `rangeAt` to opt out of both beat-side
  pinch and run-side extension and restrict results to real (measured/target) data.
- README section documenting the interpolation and extrapolation model.

### Changed

- Replaced the run-side (gybe) cosine extrapolation with a mirror-point + VMG-taper model: a single point
  mirrors the measured VMG rise around the run angle, then VMG slope is tapered linearly to zero at 180deg.
  This reliably reaches 180deg and is slope-continuous with the real data, unlike the previous model.
- The default performance factor is `1.0`, so queries without an explicit factor use the unadjusted polar values.

## 1.0.1 - 2026-09-10

### Fixed

- Accept sparse polar rows containing valid speeds on only the upwind or downwind side.
- Report unavailable beat or run targets as `null` while retaining the available targets and maximum speed.
- Report each row's actual computable angle range and avoid extrapolation when there is insufficient supporting data.
- Skip empty rows during interpolation and return a clear unavailable state when a table contains no positive speeds.

## 1.0.0 - 2026-09-09

First published release. Pure polar-table calculations extracted from `signalk-polar-performance-plugin`, built on top of `polar-format`.

### Added

- `Polar.fromTable(table)` to validate a canonical `polar-format` table and prepare it once for repeated queries.
- `speedAt({ tws, twa, performanceFactor })` for boat speed interpolation, including pinching and run-angle extrapolation.
- `vmgAt({ tws, twa, performanceFactor })` for velocity made good.
- `targetsAt({ tws, performanceFactor })` for beat, run, and max-speed targets.
- `rangeAt({ tws })` for the sailable TWA range at a given wind speed.
- Non-throwing `{ value, state }` result shape for all query methods, with `state.tws` / `state.twa` range indicators.