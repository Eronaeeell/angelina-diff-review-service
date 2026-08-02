import { Category, Finding, LineRecord, Severity } from "../types";
import { ChunkInput, Provider } from "./types";

interface RuleDef {
  severity: Severity;
  category: Category;
  title: string;
}

const RULES: Record<string, RuleDef> = {
  "MOCK-001": { severity: "critical", category: "security", title: "eval usage" },
  "MOCK-002": { severity: "critical", category: "security", title: "hardcoded credential" },
  "MOCK-003": { severity: "high", category: "security", title: "SQL string concatenation" },
  "MOCK-004": { severity: "high", category: "correctness", title: "swallowed exception" },
  "MOCK-005": { severity: "medium", category: "correctness", title: "loose null comparison" },
  "MOCK-006": { severity: "medium", category: "performance", title: "deep-clone via JSON" },
  "MOCK-007": { severity: "low", category: "style", title: "console.log left in" },
  "MOCK-008": { severity: "low", category: "style", title: "unresolved marker" },
  "MOCK-INJ": { severity: "critical", category: "security", title: "prompt-injection content" },
};

const CREDENTIAL_RE = /(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i;
const SQL_KEYWORDS = "(SELECT|INSERT|UPDATE|DELETE)";
const SQL_CONCAT_RE = new RegExp(
  `(['"][^'"]*\\b${SQL_KEYWORDS}\\b[^'"]*['"]\\s*\\+)|(\\+\\s*['"][^'"]*\\b${SQL_KEYWORDS}\\b[^'"]*['"])`,
  "i"
);
// Negative lookbehind/lookahead keep this from matching the tail of a
// strict === / !== operator (three chars), which is the opposite of what
// this rule is meant to catch.
const NULL_CMP_RE = /(?<![!=])(==|!=)(?!=)\s*null\b/;
const INJECTION_RE = /ignore previous instructions|disregard all prior|you are now/i;
const CATCH_OPEN_RE = /catch\s*\([^)]*\)\s*\{/;

function makeFinding(ruleId: string, path: string, line: number, evidence: string): Finding {
  const rule = RULES[ruleId];
  return {
    id: `${ruleId}:${path}:${line}`,
    ruleId,
    path,
    line,
    severity: rule.severity,
    category: rule.category,
    title: rule.title,
    evidence,
  };
}

function scanLineRules(path: string, line: number, text: string, out: Finding[]): void {
  if (text.includes("eval(")) out.push(makeFinding("MOCK-001", path, line, text));
  if (CREDENTIAL_RE.test(text)) out.push(makeFinding("MOCK-002", path, line, text));
  if (SQL_CONCAT_RE.test(text)) out.push(makeFinding("MOCK-003", path, line, text));
  if (NULL_CMP_RE.test(text)) out.push(makeFinding("MOCK-005", path, line, text));
  if (text.includes("JSON.parse(JSON.stringify(")) out.push(makeFinding("MOCK-006", path, line, text));
  if (text.includes("console.log(")) out.push(makeFinding("MOCK-007", path, line, text));
  if (text.includes("TODO") || text.includes("FIXME")) out.push(makeFinding("MOCK-008", path, line, text));
  if (INJECTION_RE.test(text)) out.push(makeFinding("MOCK-INJ", path, line, text));
}

interface BraceScanState {
  depth: number;
  empty: boolean;
  quote: string | null;
}

/**
 * Consumes one physical line's worth of text against a running brace-depth
 * scan, string/comment-aware so a `{`/`}` inside a string literal or a `//`
 * line comment doesn't corrupt depth tracking (which would otherwise let an
 * adversarial diff hide or fake an empty catch by embedding stray braces in
 * a string). Returns true once depth returns to zero (block closed).
 */
function consumeAware(chunk: string, state: BraceScanState): boolean {
  let inComment = false;
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i];
    if (inComment) {
      if (!/\s/.test(ch)) state.empty = false;
      continue;
    }
    if (state.quote) {
      if (!/\s/.test(ch)) state.empty = false;
      if (ch === "\\") {
        i++; // skip the escaped character too
        continue;
      }
      if (ch === state.quote) state.quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      state.quote = ch;
      state.empty = false;
      continue;
    }
    if (ch === "/" && chunk[i + 1] === "/") {
      inComment = true;
      state.empty = false;
      i++;
      continue;
    }
    if (ch === "{") {
      state.depth++;
      continue;
    }
    if (ch === "}") {
      state.depth--;
      if (state.depth === 0) return true;
      continue;
    }
    if (!/\s/.test(ch)) state.empty = false;
  }
  return false;
}

/**
 * Empty-catch detection walks physical lines (added + context, in source
 * order) starting at an added `catch (...) {` line, tracking brace depth
 * until it returns to zero. If every character seen along the way (besides
 * whitespace, braces, and string/comment delimiters) is empty, the block is
 * reported at the catch line. This is a heuristic (not a real parser) but
 * covers same-line and multi-line empty catches, a close brace that's a
 * context line, and stays correct when a string/comment contains braces.
 */
function scanEmptyCatch(path: string, records: LineRecord[], out: Finding[]): void {
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.marker !== "added") continue;
    const m = CATCH_OPEN_RE.exec(rec.text);
    if (!m) continue;

    const state: BraceScanState = { depth: 1, empty: true, quote: null };
    const afterOpen = rec.text.slice(m.index + m[0].length);

    let closed = consumeAware(afterOpen, state);
    let j = i;
    while (!closed && ++j < records.length) {
      closed = consumeAware(records[j].text, state);
    }

    if (closed && state.empty) {
      out.push(makeFinding("MOCK-004", path, rec.line, rec.text));
    }
  }
}

export const mockProvider: Provider = {
  name: "mock",
  async reviewChunk(input: ChunkInput): Promise<Finding[]> {
    const out: Finding[] = [];
    for (const { path, line, text } of input.addedLines) {
      scanLineRules(path, line, text, out);
    }
    for (const [path, records] of input.lineRecordsByPath) {
      scanEmptyCatch(path, records, out);
    }
    return out;
  },
};
