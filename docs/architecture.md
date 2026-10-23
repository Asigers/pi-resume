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
