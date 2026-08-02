// Same idea as demo.mjs, but runs through the REAL AI model (provider: "llm")
// instead of the deterministic mock rules -- shows the diff going in and the
// actual model-generated findings coming out, plus a mock-vs-llm comparison
// on the same diff so you can see the difference between fixed rules and
// real AI judgment.
// Usage: BASE=... TOKEN=... node test/demo-llm.mjs

const BASE = process.env.BASE ?? "http://localhost:3000";
const TOKEN = process.env.TOKEN ?? "test-token-123";

// A tiny random marker keeps each run's diff byte-unique so you see a real,
// fresh LLM call every time instead of an instant cache hit.
const RUN_TAG = Math.random().toString(36).slice(2, 8);
const DIFF = `diff --git a/src/userService.ts b/src/userService.ts
--- a/src/userService.ts
+++ b/src/userService.ts
@@ -1,1 +1,9 @@
+// run ${RUN_TAG}
+const dbPassword = "sk-live-9f8a7b6c5d4e3f2g1h";
+function getUser(id) {
+  const query = "SELECT * FROM users WHERE id=" + id;
+  eval(query);
+  console.log("fetched user", id);
+  try {
+    return db.run(query);
+  } catch (e) {}
+}
`;

async function submitAndWait(diff, provider) {
  const postRes = await fetch(`${BASE}/v1/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ diff, options: { provider } }),
  });
  const postJson = await postRes.json();
  if (!postJson.jobId) return { error: postJson };

  const start = Date.now();
  for (let i = 0; i < 60; i++) {
    const g = await fetch(`${BASE}/v1/reviews/${postJson.jobId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const job = await g.json();
    if (job.status === "done" || job.status === "failed") {
      job.__elapsedMs = Date.now() - start;
      return job;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { error: "timed out waiting for job (client gave up after 60s -- server-side budget is 25s so this would indicate a real problem)" };
}

function printFindings(job) {
  if (job.error) {
    console.log("  ERROR:", JSON.stringify(job.error));
    return;
  }
  if (job.status === "failed") {
    console.log(`  Job FAILED gracefully (no crash) -- error: ${job.error?.message}`);
    return;
  }
  if (!job.findings || job.findings.length === 0) {
    console.log("  No issues found.");
    return;
  }
  for (const f of job.findings) {
    console.log(`  [${f.severity.toUpperCase()}] ${f.ruleId} (${f.category}) - ${f.title}`);
    console.log(`    line ${f.line}: ${f.evidence}`);
  }
}

async function main() {
  console.log(`Testing against: ${BASE}\n`);
  console.log("Diff being reviewed (same one for both providers):");
  console.log(DIFF.trim());

  console.log("\n" + "=".repeat(70));
  console.log("PROVIDER: mock (deterministic rule table -- this is what's scored)");
  console.log("=".repeat(70));
  const mockJob = await submitAndWait(DIFF, "mock");
  console.log(`Completed in ${mockJob.__elapsedMs}ms`);
  printFindings(mockJob);

  console.log("\n" + "=".repeat(70));
  console.log("PROVIDER: llm (real AI model via OpenRouter, 4-model fallback chain)");
  console.log("=".repeat(70));
  const llmJob = await submitAndWait(DIFF, "llm");
  console.log(`Completed in ${llmJob.__elapsedMs}ms`);
  printFindings(llmJob);

  console.log("\n" + "=".repeat(70));
  console.log(
    "Note: mock findings use fixed rule IDs (MOCK-001, etc.) and are exactly\n" +
      "reproducible every time -- that's what's scored. The llm findings come\n" +
      "from a real model reading the code and use its own wording/rule names,\n" +
      "which can vary slightly between runs since it's actual AI judgment,\n" +
      "not a fixed lookup table."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
