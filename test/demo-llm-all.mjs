// Runs the same 9 rule scenarios as demo.mjs, but through the REAL AI model
// (provider: "llm") instead of the mock rules, all packed into one diff so
// it's a single AI call instead of 9. Shows what the AI actually noticed on
// each file. NOT pass/fail -- the llm path isn't held to exact-match the
// way mock is (see CANDIDATE-TASK.md: mock is what's scored; llm just needs
// to work end-to-end and fail gracefully).
// Usage: BASE=... TOKEN=... node test/demo-llm-all.mjs

const BASE = process.env.BASE ?? "http://localhost:3000";
const TOKEN = process.env.TOKEN ?? "test-token-123";

function diffForFile(path, lines) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${lines.length} @@\n${lines
    .map((l) => `+${l}`)
    .join("\n")}\n`;
}

const RUN_TAG = Math.random().toString(36).slice(2, 8);

const CASES = [
  { path: "01-eval.ts", label: "eval() usage", lines: [`// run ${RUN_TAG}`, "eval(userInput);"] },
  { path: "02-credential.ts", label: "Hardcoded credential", lines: ['const apiKey = "sk-ABCDEFGHIJKLMNOPQRST";'] },
  { path: "03-sql.ts", label: "SQL string concatenation", lines: ['const q = "SELECT * FROM users WHERE id=" + userId;'] },
  { path: "04-catch.ts", label: "Empty catch block", lines: ["try {", "  doWork();", "} catch (e) {}"] },
  { path: "05-null.ts", label: "Loose null comparison", lines: ["if (value == null) return;"] },
  { path: "06-clone.ts", label: "Deep-clone via JSON", lines: ["const copy = JSON.parse(JSON.stringify(obj));"] },
  { path: "07-log.ts", label: "console.log left in", lines: ['console.log("debug value:", value);'] },
  { path: "08-todo.ts", label: "Unresolved TODO", lines: ["// TODO: handle the edge case here"] },
  { path: "09-clean.ts", label: "Clean code (should find nothing)", lines: ["function add(a, b) {", "  return a + b;", "}"] },
];

async function main() {
  console.log(`Testing against: ${BASE}\n`);

  let diff = "";
  for (const c of CASES) diff += diffForFile(c.path, c.lines);

  console.log("Submitting one combined diff (9 files, 1 real AI call)...\n");
  const t0 = Date.now();
  const postRes = await fetch(`${BASE}/v1/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ diff, options: { provider: "llm" } }),
  });
  const postJson = await postRes.json();
  if (!postJson.jobId) {
    console.log("Submission failed:", JSON.stringify(postJson));
    return;
  }
  console.log("jobId:", postJson.jobId, "-- waiting for the AI to respond (can take 10-25s)...");

  let job;
  for (let i = 0; i < 60; i++) {
    const g = await fetch(`${BASE}/v1/reviews/${postJson.jobId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    job = await g.json();
    if (job.status === "done" || job.status === "failed") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`Completed in ${Date.now() - t0}ms, status: ${job.status}\n`);

  if (job.status === "failed") {
    console.log("Job FAILED gracefully (no crash) -- error:", job.error?.message);
    return;
  }

  for (const c of CASES) {
    console.log("=".repeat(70));
    console.log(`FILE: ${c.path}  --  ${c.label}`);
    console.log("-".repeat(70));
    console.log(c.lines.map((l) => `+${l}`).join("\n"));
    const findingsForFile = job.findings.filter((f) => f.path === c.path);
    console.log("\nAI noticed:");
    if (findingsForFile.length === 0) {
      console.log("  (nothing flagged on this file)");
    } else {
      for (const f of findingsForFile) {
        console.log(`  [${f.severity.toUpperCase()}] ${f.ruleId} - ${f.title}`);
      }
    }
    console.log();
  }

  console.log("=".repeat(70));
  console.log(`Total findings across all 9 files: ${job.findings.length}`);
  console.log("Remember: unlike the mock provider, this is real AI judgment --");
  console.log("wording and exact coverage can vary slightly between runs.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
