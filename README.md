# pi-resume

A fast, read-only session picker for Pi Coding Agent.

Status: **v0.1 preview**. Use `/presume`; the native `/resume` stays intact.

See [ROADMAP.md](ROADMAP.md) for progress and [docs/architecture.md](docs/architecture.md) for the design.

## Development

```bash
git clone https://github.com/Asigers/pi-resume.git
cd pi-resume
npm install --ignore-scripts
npm run check
pi --no-extensions -e ./src/index.ts
```

Press `/presume` in Pi. Use Tab to switch scope, arrow keys to navigate, Enter to resume, and Esc to close. The picker searches session titles, IDs and paths, **not** full transcript text.

The `@asigers/pi-resume` scoped package name is reserved as a plan; this repository does not claim an npm publication.

No session deletion or JSONL mutation is implemented. Tested Pi/TUI compatibility and performance figures are release gates, not guaranteed by this preview.

MIT licensed. Feedback should include your Pi/Node version, OS, and sanitized measurements; please never upload private session logs.