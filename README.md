# pi-resume

A **read-only incremental session picker** for [Pi Coding Agent](https://pi.dev), designed to make session browsing responsive even when the native `/resume` list takes a long time.

> **v0.1.0 preview.** Core parser/scanner tests have passed locally; real Pi TUI behavior and cross-platform benchmarks are not yet certified. No npm release is claimed.

## Features

- `/presume` opens an independent picker; native `/resume` is unchanged.
- Streams previews in 24-file asynchronous batches rather than parsing entire session transcripts.
- Reads complete JSONL lines up to the first user message (with a 2 MiB safety cap), plus at most 32 KiB from EOF to find recent renamed session titles.
- Tab switches current project / all projects; typing filters by title, ID, cwd or path.
- Arrow keys and PageUp/PageDown navigate, Enter resumes, Esc closes.
- Corrupted or disappearing files are skipped; sessions are never modified or deleted.

## Try it

Node.js 22+ and a recent compatible Pi are required.

```bash
git clone https://github.com/Asigers/pi-resume.git
cd pi-resume
npm install --ignore-scripts
npm run check
pi --no-extensions -e ./src/index.ts
```

Inside Pi: `/presume`, or `/presume django` to prefill a search term.

Once you verify compatibility, Pi's Git package installation can be used:

```bash
pi install git:github.com/Asigers/pi-resume
```

The planned npm package name is `@asigers/pi-resume`; **it has not been published**.

## Limits and safety

- No full historical message search yet; only session metadata and the first user message are searchable.
- Renames far before the last 32KiB of a session may not appear.
- A first user record exceeding the 2MiB safety bound may show a generic title.
- A huge filesystem directory or slow network disk can still cause delays; no universal millisecond guarantee.
- No count of all messages is shown, because prefix-only parsing cannot compute it accurately.
- All operations are local, with no telemetry, storage index, session modification or network requests.
- Works in Pi terminal TUI only; Pi Web integration is not claimed.

See [ROADMAP.md](ROADMAP.md), [docs/architecture.md](docs/architecture.md), and the repository's GitHub Issues.

## Test

```bash
npm install --ignore-scripts
npm test
npm run typecheck
```

CI is configured for Linux, Windows and macOS; passing CI and real terminal smoke tests are prerequisites for stable release. Bug reports should include OS, Node/Pi versions, approximate number/size of sessions and sanitized timing data. Do not upload private conversation JSONL.

MIT License.
