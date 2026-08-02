import { DiffFileBlock, Finding, LineRecord, ParsedAddedLine, ProviderName } from "../types";

export interface ChunkInput {
  files: DiffFileBlock[];
  addedLines: ParsedAddedLine[];
  lineRecordsByPath: Map<string, LineRecord[]>;
}

export interface Provider {
  name: ProviderName;
  reviewChunk(input: ChunkInput): Promise<Finding[]>;
}
