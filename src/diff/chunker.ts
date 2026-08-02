import { DiffFileBlock } from "../types";

/**
 * Bin-packs per-file diff blocks into chunks of at most `limit` bytes,
 * splitting only on file boundaries. A single file whose own block exceeds
 * `limit` becomes its own (oversized) chunk rather than being split.
 */
export function chunkFiles(files: DiffFileBlock[], limit: number): DiffFileBlock[][] {
  const chunks: DiffFileBlock[][] = [];
  let current: DiffFileBlock[] = [];
  let currentBytes = 0;

  for (const file of files) {
    if (current.length > 0 && currentBytes + file.bytes > limit) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += file.bytes;

    if (currentBytes > limit) {
      // This file alone (possibly with nothing else) already exceeds the
      // limit; it stands as its own chunk.
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}
