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
 * - missing / unreadable file → undefined (no throw)
 * - last line written partially (CLI mid-write race) → unparseable, skipped
 * - non-matching lines (user / `$set` / wrong type) → predicate filter
 * - chunk boundary mid-line → buffered across chunk reads
 * - budget exhausted before match → undefined (caller's fallback path)
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';

const DEFAULT_CHUNK_SIZE = 8192;
const DEFAULT_MAX_LINES = 10_000;
const DEFAULT_MAX_BYTES = 1_048_576; // 1 MiB
/** Cap leading-buffer growth so a pathological multi-MB single line cannot exhaust memory. */
const LEADING_BUFFER_CAP = 1_048_576;

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
export function readJsonlTail<T = unknown>(filePath: string, opts: ReadJsonlTailOptions): T | undefined {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let fd: number;
  let size: number;
  try {
    fd = openSync(filePath, 'r');
    size = statSync(filePath).size;
  } catch {
    return undefined;
  }

  try {
    if (size === 0) return undefined;

    const buffer = Buffer.alloc(DEFAULT_CHUNK_SIZE);
    let position = size;
    let bytesRead = 0;
    let linesScanned = 0;
    /** Partial leading from the previous (newer) chunk's first split element. */
    let leadingBuffer = '';

    while (position > 0) {
      const chunkSize = Math.min(DEFAULT_CHUNK_SIZE, position);
      position -= chunkSize;
      bytesRead += chunkSize;

      const n = readSync(fd, buffer, 0, chunkSize, position);
      if (n === 0) break;

      // chunkText is older content; leadingBuffer is newer content (already-read
      // chunk's first element that was a partial line). Concatenated they form
      // a contiguous slice of the file [position, position+chunkSize+|leadingBuffer|).
      const combined = buffer.toString('utf8', 0, n) + leadingBuffer;
      const parts = combined.split('\n');

      // When position > 0 we cannot trust parts[0] is a complete line — it may
      // be the back half of a line whose front half lives in the next (older)
      // chunk. Save it as leadingBuffer for the next iteration.
      // When position === 0 there is no more chunk; parts[0] is the file's
      // first line (complete) and must be processed.
      let processFromIndex: number;
      if (position === 0) {
        processFromIndex = 0;
        leadingBuffer = '';
      } else {
        processFromIndex = 1;
        leadingBuffer = parts[0] ?? '';
        if (leadingBuffer.length > LEADING_BUFFER_CAP) return undefined;
      }

      // Process complete lines in REVERSE (newest first). Skip empty (trailing
      // newline at EOF) and unparseable (partial-write race) lines.
      for (let i = parts.length - 1; i >= processFromIndex; i--) {
        const line = parts[i];
        if (line === '') continue;
        linesScanned++;
        if (linesScanned > maxLines) return undefined;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (opts.predicate(parsed)) {
          return parsed as T;
        }
      }

      if (bytesRead >= maxBytes) return undefined;
    }

    return undefined;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* best-effort */
    }
  }
}
