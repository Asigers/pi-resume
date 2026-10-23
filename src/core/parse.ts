/** Pi session JSONL metadata parsing. Always read-only. */
export interface HeaderInfo {
  id: string; cwd: string; name?: string; firstMessage?: string; parentSession?: string;
}
export function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is {type:string;text:string} =>
      typeof p === "object" && p !== null &&
      (p as {type?:unknown}).type === "text" && typeof (p as {text?:unknown}).text === "string")
    .map(p => p.text).join(" ");
}
/** Returns true after processing the first user message. Invalid lines are skipped. */
export function acceptHeaderLine(h: HeaderInfo, line: string): boolean {
  let entry: Record<string, unknown>;
  try { entry = JSON.parse(line); } catch { return false; }
  if (!entry || typeof entry !== "object") return false;
  if (entry.type === "session") {
    if (typeof entry.id === "string") h.id = entry.id;
    if (typeof entry.cwd === "string") h.cwd = entry.cwd;
    if (typeof entry.parentSession === "string") h.parentSession = entry.parentSession;
  } else if (entry.type === "session_info") {
    h.name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
  } else if (entry.type === "message") {
    const msg = entry.message as {role?:unknown;content?:unknown}|undefined;
    if (msg?.role === "user") {
      h.firstMessage = extractUserText(msg.content);
      return true;
    }
  }
  return false;
}
export function tailName(data: Buffer, completeFirstLine: boolean): {found:boolean;name?:string} {
  const lines = data.toString("utf8").split("\n");
  let found = false, name: string|undefined;
  for (const line of completeFirstLine ? lines : lines.slice(1)) {
    if (!line.includes('"session_info"')) continue;
    try {
      const entry = JSON.parse(line) as {type?:string;name?:unknown};
      if (entry.type !== "session_info") continue;
      found = true;
      name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
    } catch { /* Skip incomplete JSONL */ }
  }
  return {found,name};
}
export function previewTitle(h: HeaderInfo): string {
  return (h.name || h.firstMessage || "(no user message)")
    .replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0,180) || "(empty message)";
}
