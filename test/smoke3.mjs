const BASE = process.env.BASE ?? "http://localhost:3000";
const TOKEN = process.env.TOKEN ?? "test-token-123";

function makeFile(path, nLines) {
  let hunk = `diff --git a/${path} b/${path}\nindex 000000..111111 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${nLines} @@\n`;
  for (let i = 0; i < nLines; i++) {
    hunk += `+const line${i} = ${i}; // console.log(${i});\n`;
  }
  return hunk;
}

async function post(body, headers = {}) {
  const res = await fetch(`${BASE}/v1/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function main() {
  // 413: payload over 1 MiB
  const hugeDiff = makeFile("src/huge.ts", 1) + "x".repeat(1024 * 1024 * 2);
  const big = await post({ diff: hugeDiff });
  console.log("oversized payload (expect 413):", big.status, big.json);

  // Chunking: build a diff with 4 files each ~30KiB of added lines -> total ~120KiB -> multiple chunks
  let multiFileDiff = "";
  for (let f = 0; f < 4; f++) {
    multiFileDiff += makeFile(`src/file${f}.ts`, 700); // ~700 lines * ~35 bytes ~= 24KB per file
  }
  console.log("multiFileDiff bytes:", Buffer.byteLength(multiFileDiff, "utf8"));
  const chunkRes = await post({ diff: multiFileDiff });
  let job;
  for (let i = 0; i < 30; i++) {
    const g = await fetch(`${BASE}/v1/reviews/${chunkRes.json.jobId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    job = await g.json();
    if (job.status === "done" || job.status === "failed") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log("chunked job status:", job.status, "usage:", job.usage, "findingsCount:", job.findings?.length);

  // Concurrency: fire 5 jobs at once, all must eventually complete (5th must not fail outright)
  const diff5 = makeFile("src/conc.ts", 50);
  const submissions = await Promise.all(Array.from({ length: 5 }, () => post({ diff: diff5 + Math.random() })));
  console.log("concurrent submissions statuses:", submissions.map((s) => s.status));

  // Rate limiting: fire ~20 requests instantly, expect some 429s with Retry-After
  const burstDiff = makeFile("src/burst.ts", 5);
  const burst = await Promise.all(
    Array.from({ length: 20 }, () => post({ diff: burstDiff + Math.random() }))
  );
  const statuses = burst.map((b) => b.status);
  const count202 = statuses.filter((s) => s === 202).length;
  const count429 = statuses.filter((s) => s === 429).length;
  console.log("burst results: 202 count =", count202, "429 count =", count429);
  console.log("any 5xx in burst?", statuses.some((s) => s >= 500));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
