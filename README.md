# pi-resume

A **fast incremental session picker with optional local archiving** for [Pi Coding Agent](https://pi.dev), designed to make session browsing responsive even when the native `/resume` list takes a long time.

> **Preview.** Core parser/scanner tests have passed locally; real Pi TUI behavior and cross-platform benchmarks are not yet certified. No npm release is claimed.

## Features

- `/presume` opens an independent picker; native `/resume` is unchanged.
- Streams previews in 24-file asynchronous batches rather than parsing entire session transcripts.
- All scope scans the current project first, progressively discovers others and isolates broken directories.
- Repeated opens show a warm in-memory snapshot immediately, revalidated in the background via mtime/size; no persistent cache.
- Reads complete JSONL lines up to the first user message (with a 2 MiB safety cap), plus at most 32 KiB from EOF to find recent renamed session titles.
- Threaded view matches Pi's parent-child layout: linked forks/sessions appear beneath their parent when search is empty.
- The active session is shown in a `CURRENT:` header and `[CURRENT]` on its row; the picker initially focuses that row when it becomes available.
- Tab switches current project / all projects; typing filters by title, ID, cwd or path.
- Arrow keys and PageUp/PageDown navigate, Enter resumes, Esc closes.
- Corrupted or disappearing files are skipped; transcripts remain unchanged except when you explicitly move one to system Trash.
- Ctrl+A archives/restores selected sessions; Ctrl+R toggles the Archived view. Archived sessions are hidden only in `/presume`.
- Ctrl+D moves a selected historical session to the OS Trash after confirmation; child sessions are retained.

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

## Local archive

Inside `/presume`:

- **Ctrl+A** archives the selected session in Active view, or restores it in Archived view.
- **Ctrl+R** toggles Active/Archived. **Tab** switches Current/All project scope.
- **Enter** resumes in Active view or restores in Archived view (without opening that session).
- Text search filters sessions within the selected view.

The extension stores only normalized local session paths at
`~/.pi/agent/pi-resume/archive.json` (relative to the configured Pi agent directory).
It uses an atomic index replacement and **never moves or rewrites session JSONL**.
Consequently, **Pi's native `/resume` still lists archived sessions**; archiving hides them
only in this extension.

If the index has an invalid version or damaged JSON, the picker reports an error rather
than overwriting it. Removed session files may leave stale entries in the archive index;
these do not interfere with scanning.

## Move a session to Trash

Highlight a session in either Active or Archived view and press **Ctrl+D**.
The picker displays its title and file path. Press **Y** to confirm or **N/Esc**
to cancel. An active/current session is protected: switch away before trashing it.

Only that session's JSONL is moved to your **operating system's Trash/Recycle Bin**.
Children and other linked sessions are not moved. If the parent is trashed,
children can remain visible as orphaned sessions until the parent is restored.
Restore a deleted session using your OS Trash/Recycle Bin; this is different
from Ctrl+A, which only changes archive metadata.

The extension verifies that the file is a regular `.jsonl` and that its size
and modification time have not changed since the picker read it. A modified
or missing file causes a safe failure; reopen `/presume` to refresh.
If system Trash is unavailable, **the extension does not permanently delete**.
After a successful move, the session disappears from both views and any matching
archive metadata is cleared. An archive index write error is displayed as
a warning, without misreporting the successful Trash move.




Once you verify compatibility, Pi's Git package installation can be used:

```bash
pi install git:github.com/Asigers/pi-resume
```

The planned npm package name is `@asigers/pi-resume`; **it has not been published**.

## Limits and safety

- No full historical message search yet; only session metadata and the first user message are searchable.
- Tree relationships require the persisted JSONL `parentSession` field. A subagent with no linked or persisted session (such as Pi's example that uses `--no-session`) cannot be reliably attached to a parent. Search results are intentionally flat, like Pi's built-in picker.
- Renames far before the last 32KiB of a session may not appear.
- A first user record exceeding the 2MiB safety bound may show a generic title.
- A huge filesystem directory or slow network disk can still cause delays; no universal millisecond guarantee. Revalidation still performs directory traversal and stat calls.
- No count of all messages is shown, because prefix-only parsing cannot compute it accurately.
- All operations are local, with no telemetry or network requests; archiving persists a separate path-only JSON index, and explicit deletion moves the selected JSONL into system Trash.
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
