# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0 - 2026-09-09

First published release. Pure polar-table calculations extracted from `signalk-polar-performance-plugin`, built on top of `polar-format`.

### Added

- `Polar.fromTable(table)` to validate a canonical `polar-format` table and prepare it once for repeated queries.
- `speedAt({ tws, twa, performanceFactor })` for boat speed interpolation, including pinching and run-angle extrapolation.
- `vmgAt({ tws, twa, performanceFactor })` for velocity made good.
- `targetsAt({ tws, performanceFactor })` for beat, run, and max-speed targets.
- `rangeAt({ tws })` for the sailable TWA range at a given wind speed.
- Non-throwing `{ value, state }` result shape for all query methods, with `state.tws` / `state.twa` range indicators.