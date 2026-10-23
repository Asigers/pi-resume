# pi-resume Roadmap

Updated: 2026-10-23. This file is the canonical plan; linked GitHub issues carry individual tasks. Benchmark figures are targets, **not** verified results.

## Product principles

1. Show useful results while older sessions are still loading.
2. Never rewrite Pi's JSONL or permanently delete sessions silently.
3. Keep the native `/resume` untouched by default.
4. Report honest, reproducible latency measurements (OS, Pi version, disk, corpus size, mean/P95).
5. Do not misrepresent partial message counts as complete.

## v0.1 — Fast Picker MVP

- [x] Independent `/presume` command.
- [x] Async 24-file bounded batches and progressive TUI.
- [x] Prefix JSONL reader + bounded tail for recent renames.
- [x] Current/All scopes, search, keyboard navigation.
- [x] Use `ctx.switchSession()` to resume.
- [x] Skip broken files; cancel pending work when the picker closes.
- [x] Unit tests for parser, scanner, search, cancellation.
- [x] CI workflow configuration for Windows/macOS/Linux.
- [ ] Verify typecheck + CI results with real Pi dependencies.
- [ ] Smoke test actual Pi terminal UI on each OS.
- [ ] Synthetic and real-world benchmarks; publish reproducible reports.
- [ ] Release preview only after compatibility verification.

## v0.2 — Reliable Resume

- [ ] In-process metadata cache with mtime/size invalidation.
- [ ] Timed background scans, robust cancellation, UI responsiveness metrics.
- [ ] Handle selection stability, terminal resizing and custom session directories.
- [ ] `/presume stats` and diagnostic errors.
- [ ] Recent-history, named and pinned filters.
- [ ] Optional, tested native `/resume` integration with automatic rollback.
- [ ] Safe rename, trash-only deletion (never fallback to permanent deletion).

## v1.0 — Smart Resume

- [ ] Opt-in SQLite full-text index, updated incrementally.
- [ ] Fast search inside complete conversation histories without blocking picker.
- [ ] Subagent session hierarchy, preview and project filters.
- [ ] Windows/macOS/Linux benchmark comparisons with Pi native and alternatives.
- [ ] Crash recovery, index repair, documentation and versioned compatibility matrix.

## Acceptance targets (unverified)

| Corpus | Goal |
| --- | --- |
| 500 current-project sessions on SSD | First useful results P95 under 100ms |
| 3,000 sessions / ~1GB across projects | Current-project first useful results P95 under 150ms |
| 100MB JSONL with ordinary first message | No full-file parsing required |
| Corrupt/vanished files | Skip safely, preserve other sessions |
| Cancel / Esc | No additional UI updates after close |

## Decision log

- 2026-10-23: use separate command first, not prototype monkey patch.
- 2026-10-23: no session writes, deletions, remote data, persistence or telemetry in MVP.
- 2026-10-23: no fake message count, no universal speed claim.
- 2026-10-23: planned scoped npm name: `@asigers/pi-resume`.

## Tracking issues

- [#1 — Pi TUI compatibility and cross-platform CI](https://github.com/Asigers/pi-resume/issues/1) — v0.1 release gate
- [#2 — Reproducible benchmarks](https://github.com/Asigers/pi-resume/issues/2) — v0.1 release gate
- [#3 — Metadata cache and cancellation](https://github.com/Asigers/pi-resume/issues/3) — v0.2
- [#4 — Optional native /resume integration](https://github.com/Asigers/pi-resume/issues/4) — v0.2
- [#5 — Opt-in SQLite FTS](https://github.com/Asigers/pi-resume/issues/5) — v1.0
