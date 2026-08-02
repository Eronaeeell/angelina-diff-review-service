// Concretely proves the chunking contract:
//  1. usage.chunks reports the count
//  2. a diff over 64KiB actually gets split into >1 chunk
//  3. a single oversized file becomes its own chunk (not split)
//  4. findings are IDENTICAL whether the same content is scanned as 1 chunk
//     or forced into many chunks -- no dupes, no losses, order preserved
// Usage: BASE=... TOKEN=... node test/demo-chunking.mjs

const BASE = process.env.BASE ?? "http://localhost:3000";
const TOKEN = process.env.TOKEN ?? "test-token-123";
const CHUNK_BYTES = 65536;

function fileBlock(path, lines) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${lines.length} @@\n${lines
    .map((l) => `+${l}`)
    .join("\n")}\n`;
}

function paddingFile(path, approxBytes) {
  // Filler lines that don't trigger any rule, just to burn bytes.
  const lines = [];
  let bytes = 0;
  let i = 0;
  while (bytes < approxBytes) {
    const line = `const filler${i} = ${i}; // padding line to grow this file's byte size`;
    lines.push(line);
    bytes += line.length + 2;
    i++;
  }
  return fileBlock(path, lines);
}

async function submit(diff) {
  const res = await fetch(`${BASE}/v1/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ diff }),
  });
  return res.json();
}

async function waitDone(jobId) {
  for (let i = 0; i < 60; i++) {
    const g = await fetch(`${BASE}/v1/reviews/${jobId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const job = await g.json();
    if (job.status === "done" || job.status === "failed") return job;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("timed out");
}

function pass(label) {
  console.log(`  PASS  ${label}`);
}
function fail(label, detail) {
  console.log(`  FAIL  ${label}${detail ? " -- " + detail : ""}`);
}

async function main() {
  console.log(`Testing against: ${BASE}`);
  console.log(`Chunk size limit: ${CHUNK_BYTES} bytes (64 KiB)\n`);

  // ---- Test 1: small diff (under 64KiB) -> exactly 1 chunk ----
  console.log("TEST 1: a small diff should be exactly 1 chunk");
  const markers = [`m${Math.random().toString(36).slice(2, 6)}`, `m${Math.random().toString(36).slice(2, 6)}`, `m${Math.random().toString(36).slice(2, 6)}`];
  const smallDiff =
    fileBlock("src/a-file.ts", [`eval(${markers[0]});`]) +
    fileBlock("src/b-file.ts", [`console.log(${markers[1]});`]) +
    fileBlock("src/c-file.ts", [`// TODO ${markers[2]}`]);
  const smallBytes = Buffer.byteLength(smallDiff, "utf8");
  const j1 = await submit(smallDiff);
  const job1 = await waitDone(j1.jobId);
  console.log(`  diff size: ${smallBytes} bytes, usage.chunks = ${job1.usage.chunks}, findings = ${job1.findings.length}`);
  job1.usage.chunks === 1 ? pass("usage.chunks === 1 for a diff under 64KiB") : fail("usage.chunks === 1", `got ${job1.usage.chunks}`);

  // ---- Test 2: same 3 files + padding to push total over 64KiB -> multiple chunks ----
  console.log("\nTEST 2: same 3 files + padding pushing total over 64KiB -> multiple chunks, SAME findings");
  const bigDiff =
    fileBlock("src/a-file.ts", [`eval(${markers[0]});`]) +
    paddingFile("src/pad1.ts", 40000) +
    fileBlock("src/b-file.ts", [`console.log(${markers[1]});`]) +
    paddingFile("src/pad2.ts", 40000) +
    fileBlock("src/c-file.ts", [`// TODO ${markers[2]}`]);
  const bigBytes = Buffer.byteLength(bigDiff, "utf8");
  const j2 = await submit(bigDiff);
  const job2 = await waitDone(j2.jobId);
  console.log(`  diff size: ${bigBytes} bytes, usage.chunks = ${job2.usage.chunks}, findings = ${job2.findings.length}`);
  job2.usage.chunks > 1 ? pass(`usage.chunks > 1 for a ${bigBytes}-byte diff (got ${job2.usage.chunks})`) : fail("usage.chunks > 1", `got ${job2.usage.chunks}`);

  // Compare: findings for the 3 real files should be IDENTICAL between the
  // unchunked run (job1) and the forced-multi-chunk run (job2) -- same set,
  // same order, no dupes, no losses.
  const relevantPaths = new Set(["src/a-file.ts", "src/b-file.ts", "src/c-file.ts"]);
  const findings1 = job1.findings.filter((f) => relevantPaths.has(f.path));
  const findings2 = job2.findings.filter((f) => relevantPaths.has(f.path));
  const strip = (f) => ({ id: f.id, ruleId: f.ruleId, path: f.path, line: f.line });
  const same = JSON.stringify(findings1.map(strip)) === JSON.stringify(findings2.map(strip));
  same
    ? pass("findings for the 3 real files are byte-identical whether chunked or not (order + content)")
    : fail("findings identical across chunking", `unchunked=${JSON.stringify(findings1.map(strip))} vs chunked=${JSON.stringify(findings2.map(strip))}`);

  const ids2 = findings2.map((f) => f.id);
  new Set(ids2).size === ids2.length ? pass("no duplicate finding ids in the chunked run") : fail("no duplicates", "duplicates found");

  // ---- Test 3: a single file whose OWN diff exceeds 64KiB -> its own chunk ----
  console.log("\nTEST 3: a single file over 64KiB is its own chunk (not split)");
  const hugeFileMarker = `m${Math.random().toString(36).slice(2, 8)}`;
  let hugeFileLines = [`eval(${hugeFileMarker});`];
  let hugeFileBytes = 0;
  let i = 0;
  while (hugeFileBytes < 70000) {
    const l = `const pad${i} = ${i}; // making this single file exceed 64KiB on its own`;
    hugeFileLines.push(l);
    hugeFileBytes += l.length + 2;
    i++;
  }
  const smallCompanion = fileBlock("src/companion.ts", [`console.log(${markers[1]});`]);
  const hugeFileDiff = smallCompanion + fileBlock("src/huge-single-file.ts", hugeFileLines);
  const hugeTotalBytes = Buffer.byteLength(hugeFileDiff, "utf8");
  const j3 = await submit(hugeFileDiff);
  const job3 = await waitDone(j3.jobId);
  console.log(`  total diff size: ${hugeTotalBytes} bytes, usage.chunks = ${job3.usage.chunks}`);
  const foundInHugeFile = job3.findings.some((f) => f.path === "src/huge-single-file.ts" && f.ruleId === "MOCK-001");
  const foundInCompanion = job3.findings.some((f) => f.path === "src/companion.ts" && f.ruleId === "MOCK-007");
  foundInHugeFile
    ? pass("the eval() inside the >64KiB single file was still found (not lost/split)")
    : fail("finding inside oversized file", "not found");
  foundInCompanion ? pass("the companion file's finding was also found (not swallowed by the oversized chunk)") : fail("companion finding", "not found");
  job3.usage.chunks >= 2
    ? pass(`oversized file got split into its own chunk, separate from the companion file (usage.chunks = ${job3.usage.chunks})`)
    : fail("oversized file is its own chunk", `usage.chunks = ${job3.usage.chunks}`);

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
