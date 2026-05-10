/**
 * Reverse-tail JSONL reader.
 *
 * Reads a JSONL file from EOF backward, parsing entries one at a time
 * (most-recent first), and returns the first entry that matches `predicate`.
 *
 * Designed for the Gemini per-turn `tokens.total` use case: the local
 * Gemini CLI session jsonl can grow to multi-megabyte sizes, but we only
 * ever need the latest matching message. Loading the whole file with
 * `readFileSync + split('\n')` on every model turn would block the Node.js
 * event loop. This helper opens an fd, reads small chunks from the tail,
 * and stops as soon as a match is found OR a budget is exhausted.
 *
 * Edge cases handled:
 * - empty file → undefined
 * - last line written partially (CLI mid-write race) → unparseable, skipped
 * - non-matching lines (user / `$set` / wrong type) → predicate filter
 * - chunk boundary mid-line → buffered across chunk reads
 * - budget exhausted before match → undefined (caller's fallback path)
 *
 * NOTE: stub implementation. Real reverse-tail logic to follow.
 */

export interface ReadJsonlTailOptions {
  /** Max lines to scan from EOF backward before giving up. Default: 10_000. */
  readonly maxLines?: number;
  /** Max bytes to read from EOF before giving up. Default: 1_048_576 (1 MiB). */
  readonly maxBytes?: number;
  /** Returns true if the parsed JSON entry is the one we want. */
  readonly predicate: (parsed: unknown) => boolean;
}

/**
 * Read a JSONL file from EOF backward and return the latest entry whose
 * parsed JSON matches `predicate`. Returns `undefined` when no match is
 * found within the budget or when the file is unreadable / empty.
 */
export function readJsonlTail<T = unknown>(_filePath: string, _opts: ReadJsonlTailOptions): T | undefined {
  // Stub: real implementation lands in the GREEN commit.
  return undefined;
}
