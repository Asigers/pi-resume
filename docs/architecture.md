# Architecture: v0.1

## Execution flow

1. `src/index.ts` registers `/presume` and uses the official command context.
2. `ctx.ui.custom()` creates the TUI **before** starting any filesystem work.
3. `scanSessions()` lists JSONL files in the current or default global sessions directory.
4. It reads metadata in bounded asynchronous groups of 24 files.
5. `readPreview()` scans complete JSONL lines up to the first user message, capped at 2MiB, plus a tail of up to 32KiB for recent names.
6. `ResumePicker.update()` appends batches and preserves the selected file path when results reorder.
7. `findSessions()` handles case-insensitive, metadata-only search and mtime sorting.
8. Esc or selection closes the picker, aborts future work, and ignores late results.
9. A chosen path is passed to `ctx.switchSession()`; Pi owns the session replacement.

## Tradeoffs

- The full directory listing and metadata scan still require work; filename ordering only prioritizes likely recent sessions.
- A rename older than the tail window and a very large first record may be displayed imperfectly.
- Active `fs.promises` reads cannot be forcibly interrupted; cancellation suppresses downstream updates and future batches.
- By design, a session's true message count and full message search are not available from a prefix-only read.
- Pi Web and older/unsupported Pi versions are not certified yet.

## Security

No JSONL file writes, renames, deletion, telemetry, network requests, or persistent cache/index. Session titles may contain private text but remain in the local terminal UI.


## Reliability and caching update (2026-10-23)

- All mode now yields the current directory first, then iterates other project directories with async `opendir()`. It reports partial progress before discovering the full global file count. `total` increases during discovery; a trailing `+` in the UI means discovery remains active.
- Individual directory failures are counted and skipped; other directories continue.
- Completed in-process scans store a limited warm snapshot, displayed immediately on reopening. Revalidation updates changed entries and removes deleted sessions at scan completion. Failed scans do not overwrite a complete warm snapshot.
- File preview parsing uses an LRU-style process cache keyed by absolute path, size and modified time. Each revalidation still does directory discovery and `stat()`; a file with unchanged mtime and size is assumed unchanged. For stricter consistency, restart Pi or clear the cache in tests.
- Windows path matching uses case-insensitive `win32.resolve()`, while POSIX comparison remains case-sensitive.
- Search/filter/sort results are cached per data generation and query. Background batches invalidate the cache, but TUI re-rendering alone does not.
- Work remains: benchmarks, more responsive file system cancellation, TUI smoke tests, handling exceptional timestamps/metadata, and CI verification.
