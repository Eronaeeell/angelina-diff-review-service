import fs from "fs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const TOKEN = process.env.TOKEN ?? "test-token-123";
const diff = fs.readFileSync(new URL("./fixtures/smoke.diff", import.meta.url), "utf8");

async function main() {
  const postRes = await fetch(`${BASE}/v1/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ diff, options: { provider: "mock" } }),
  });
  const postJson = await postRes.json();
  console.log("POST", postRes.status, postJson);

  const jobId = postJson.jobId;
  let job;
  for (let i = 0; i < 20; i++) {
    const getRes = await fetch(`${BASE}/v1/reviews/${jobId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    job = await getRes.json();
    if (job.status === "done" || job.status === "failed") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log("GET final:", JSON.stringify(job, null, 2));

  // cache-hit check: resubmit identical body
  const postRes2 = await fetch(`${BASE}/v1/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ diff, options: { provider: "mock" } }),
  });
  const postJson2 = await postRes2.json();
  const getRes2 = await fetch(`${BASE}/v1/reviews/${postJson2.jobId}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const job2 = await getRes2.json();
  console.log("cache hit run usage:", job2.usage);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
