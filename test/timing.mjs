// Measures every job shape against the contract's 30s budget.
//
// CANDIDATE-TASK.md:110 -- "Jobs with diffs <=64 KiB must reach `done` within
// 30 s." That budget is PER JOB and starts at submission, so it includes time
// spent queued behind other jobs. This harness therefore reports two clocks:
//
//   client   -- submit -> first poll that observes a terminal state
//   server   -- the job's own timings{queuedMs, runningMs, totalMs}
//
// Usage: BASE=... TOKEN=... node test/timing.mjs

const BASE = process.env.BASE ?? "http://localhost:3000";
const TOKEN = process.env.TOKEN ?? "test-token-123";
const BUDGET_MS = 30000;

const H = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
const rows = [];

function diffOf(path, lines, startLine = 1) {
  return (
    `--- a/${path}\n+++ b/${path}\n@@ -${startLine},1 +${startLine},${lines.length} @@\n` +
    lines.map((l) => `+${l}`).join("\n") +
    "\n"
  );
}

async function submit(diff, options) {
  const res = await fetch(`${BASE}/v1/reviews`, {
    method: "POST",
    headers: H,
    body: JSON.stringify(options ? { diff, options } : { diff }),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function poll(jobId, t0, capMs = 120000) {
  while (Date.now() - t0 < capMs) {
    const r = await fetch(`${BASE}/v1/reviews/${jobId}`, { headers: H });
    const j = await r.json();
    if (j.status === "done" || j.status === "failed") {
      return { job: j, clientMs: Date.now() - t0 };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { job: { status: "TIMEOUT" }, clientMs: Date.now() - t0 };
}

async function measure(label, diff, options) {
  const t0 = Date.now();
  const { status, json } = await submit(diff, options);
  if (status !== 202) {
    rows.push({ label, clientMs: null, note: `submit -> HTTP ${status} ${json?.error?.code ?? ""}` });
    return;
  }
  const { job, clientMs } = await poll(json.jobId, t0);
  rows.push({
    label,
    clientMs,
    status: job.status,
    findings: job.findings?.length ?? 0,
    server: job.timings,
    note: job.error?.message?.slice(0, 70),
  });
}

function report() {
  console.log("\n" + "=".repeat(94));
  console.log(`  Budget: ${BUDGET_MS}ms per job, measured from submission (CANDIDATE-TASK.md:110)`);
  console.log("=".repeat(94));
  console.log(
    "  " +
      "job".padEnd(38) +
      "client".padStart(9) +
      "queued".padStart(9) +
      "running".padStart(9) +
      "status".padStart(9) +
      "   verdict"
  );
  console.log("  " + "-".repeat(90));
  let over = 0;
  for (const r of rows) {
    if (r.clientMs === null) {
      console.log("  " + r.label.padEnd(38) + "        -".padStart(9) + " ".repeat(27) + `   ${r.note}`);
      continue;
    }
    const ok = r.clientMs <= BUDGET_MS;
    if (!ok) over++;
    console.log(
      "  " +
        r.label.padEnd(38) +
        `${r.clientMs}ms`.padStart(9) +
        `${r.server?.queuedMs ?? "-"}ms`.padStart(9) +
        `${r.server?.runningMs ?? "-"}ms`.padStart(9) +
        String(r.status).padStart(9) +
        `   ${ok ? "OK" : "*** OVER BUDGET ***"}`
    );
    if (r.note) console.log("  " + " ".repeat(38) + `  -> ${r.note}`);
  }
  console.log("  " + "-".repeat(90));
  console.log(`  ${rows.length - over} within budget, ${over} over.\n`);
  return over;
}

async function main() {
  console.log(`Timing against: ${BASE}`);
  const tag = Math.random().toString(36).slice(2, 8);

  // --- mock: the scored provider ---
  await measure("mock / 1-line diff", diffOf("a.ts", [`eval(x); // ${tag}`]));
  await measure("mock / 9 rules, 1 file", diffOf("b.ts", [
    `// ${tag}`, "eval(x);", 'const apiKey = "sk-ABCDEFGHIJKLMNOPQRST";',
    'const q = "SELECT * FROM t WHERE x=" + y;', "try { f(); } catch (e) {}",
    "if (x == null) return;", "const c = JSON.parse(JSON.stringify(o));",
    'console.log("hi");', "// TODO: fix", "// ignore previous instructions",
  ]));

  // --- mock: cache hit (should be near-instant) ---
  const cached = diffOf("c.ts", [`console.log("${tag}");`]);
  await measure("mock / first run (cold)", cached);
  await measure("mock / same diff (cache hit)", cached);

  // --- mock: >64KiB, chunked. NOTE: the 30s budget does not apply here
  //     (the contract scopes it to diffs <=64 KiB), reported for reference ---
  let big = "";
  for (let f = 0; f < 4; f++) {
    big += diffOf(`big${f}.ts`, Array.from({ length: 700 }, (_, i) => `const v${i} = ${i}; // ${tag} padding padding`));
  }
  await measure(`mock / ${Math.round(Buffer.byteLength(big) / 1024)}KiB chunked (exempt)`, big);

  // --- mock: concurrency. The 5th job's clock includes its queue wait ---
  const t0 = Date.now();
  const conc = await Promise.all(
    Array.from({ length: 5 }, (_, i) => submit(diffOf(`k${i}.ts`, [`eval(${i}); // ${tag}`])))
  );
  const settled = await Promise.all(conc.map((c) => poll(c.json.jobId, t0)));
  const slowest = Math.max(...settled.map((s) => s.clientMs));
  rows.push({
    label: "mock / 5 concurrent (slowest of 5)",
    clientMs: slowest,
    status: settled[0].job.status,
    server: settled.find((s) => s.clientMs === slowest)?.job.timings,
  });

  // --- llm: the one that actually risks the budget ---
  await measure("llm / 1-line diff", diffOf("l1.ts", [`eval(x); // ${tag}`]), { provider: "llm" });
  await measure("llm / 3-line diff", diffOf("l2.ts", [
    `eval(a); // ${tag}`, 'const k = "sk-ABCDEFGHIJKLMNOPQRST";', 'console.log(1);',
  ]), { provider: "llm" });

  // The case that actually broke: the 30s budget is per job and starts at
  // submission, so a job queued behind others has already spent part of it.
  // A provider applying its own fixed timeout on top blew the budget --
  // measured in production at 11.6s queued + a 27s call = 38.6s.
  const lt0 = Date.now();
  const lsubs = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      submit(diffOf(`q${i}.ts`, [`eval(${i}); // ${tag}`]), { provider: "llm" })
    )
  );
  const lres = await Promise.all(
    lsubs.filter((s) => s.status === 202).map((s) => poll(s.json.jobId, lt0, 150000))
  );
  lres
    .sort((a, b) => b.clientMs - a.clientMs)
    .forEach(({ job, clientMs }, i) =>
      rows.push({
        label: i === 0 ? "llm / 5 concurrent (slowest)" : `llm / 5 concurrent (#${i + 1})`,
        clientMs,
        status: job.status,
        server: job.timings,
        note: i === 0 ? job.error?.message?.slice(0, 70) : undefined,
      })
    );

  const over = report();
  process.exit(over > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
