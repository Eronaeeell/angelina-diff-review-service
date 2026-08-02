import { DiffFileBlock, LineRecord, ParsedAddedLine } from "../types";

export interface ParsedDiff {
  files: DiffFileBlock[];
  addedLines: ParsedAddedLine[];
  lineRecordsByPath: Map<string, LineRecord[]>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Strips the conventional `a/`/`b/` diff prefixes. Applied unconditionally,
 * not just when `diff --git` headers are present: a hand-written unified diff
 * frequently carries the prefixes without the `diff --git` line, and leaving
 * them on would put `b/` into every finding's `path` and `id`.
 */
function stripPrefix(path: string): string {
  if (path === "/dev/null") return path;
  if (path.startsWith("a/") || path.startsWith("b/")) {
    return path.slice(2);
  }
  return path;
}

function extractPath(blockLines: string[], marker: "+++" | "---"): string | null {
  for (const line of blockLines) {
    if (line.startsWith(marker + " ")) {
      let rest = line.slice(4);
      rest = rest.replace(/\r?\n$/, "");
      // strip trailing tab-separated timestamp, e.g. "b/foo.ts\t2024-01-01 ..."
      const tabIdx = rest.indexOf("\t");
      if (tabIdx !== -1) rest = rest.slice(0, tabIdx);
      return stripPrefix(rest.trim());
    }
  }
  return null;
}

/**
 * Parses a unified diff into per-file raw blocks (for chunking) and a flat
 * list of added lines with their new-file line numbers (for rule matching).
 * Returns null if the input has no recognizable file/hunk structure.
 */
export function parseUnifiedDiff(raw: string): ParsedDiff | null {
  if (!raw || raw.trim().length === 0) return null;

  // Split into lines, keeping the newline attached to each line so we can
  // losslessly reconstruct exact byte spans per file for chunking.
  const lines = raw.split(/(?<=\n)/);

  const hasGitHeaders = lines.some((l) => l.startsWith("diff --git "));

  const boundaries: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (hasGitHeaders) {
      if (line.startsWith("diff --git ")) boundaries.push(i);
    } else if (line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ")) {
      // Without `diff --git` markers, a `--- ` line only starts a new file
      // block if the very next line is its `+++ ` counterpart -- otherwise a
      // *removed* line whose content happens to begin with "-- " would split
      // the diff at the wrong place.
      boundaries.push(i);
    }
  }

  if (boundaries.length === 0) return null;

  // Detected over the whole input rather than per file block: a diff that only
  // deletes files skips the per-block body loop below, but is still a valid
  // parseable diff (it just yields no added lines, hence no findings).
  const anyHunkFound = lines.some((l) => HUNK_HEADER.test(l));
  if (!anyHunkFound) return null;

  const files: DiffFileBlock[] = [];
  const addedLines: ParsedAddedLine[] = [];
  const lineRecordsByPath = new Map<string, LineRecord[]>();

  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b];
    const end = b + 1 < boundaries.length ? boundaries[b + 1] : lines.length;
    const blockLines = lines.slice(start, end);
    const rawBlock = blockLines.join("");

    const newPath = extractPath(blockLines, "+++");
    const oldPath = extractPath(blockLines, "---");
    const path = newPath && newPath !== "/dev/null" ? newPath : oldPath ?? newPath ?? `file-${b}`;

    files.push({
      path,
      raw: rawBlock,
      bytes: Buffer.byteLength(rawBlock, "utf8"),
    });

    // File was deleted (no new file to attribute added lines to).
    if (newPath === "/dev/null") continue;

    const records: LineRecord[] = lineRecordsByPath.get(path) ?? [];
    lineRecordsByPath.set(path, records);

    let newLineCounter = -1;
    for (const line of blockLines) {
      const hunkMatch = HUNK_HEADER.exec(line);
      if (hunkMatch) {
        newLineCounter = parseInt(hunkMatch[3], 10);
        continue;
      }
      // Before the first hunk in this block -- this is where the `---`/`+++`
      // file headers live, so they're skipped here. Deliberately NOT skipped
      // once a hunk has started: inside a hunk, `+++foo` is an added line
      // whose content is `++foo`, and dropping it would desync every
      // subsequent line number in the file.
      if (newLineCounter === -1) continue;

      if (line.startsWith("+")) {
        const text = line.slice(1).replace(/\r?\n$/, "");
        addedLines.push({ path, line: newLineCounter, text });
        records.push({ marker: "added", line: newLineCounter, text });
        newLineCounter++;
      } else if (line.startsWith("-")) {
        // old-file-only line; new line counter unaffected
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file" marker; ignore
      } else {
        // context line (leading space, or blank line with no marker)
        const text = line.replace(/^ /, "").replace(/\r?\n$/, "");
        records.push({ marker: "context", line: newLineCounter, text });
        newLineCounter++;
      }
    }
  }

  return { files, addedLines, lineRecordsByPath };
}
