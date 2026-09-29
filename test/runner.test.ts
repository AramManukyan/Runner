// MOCK-LEVEL integration test: real HTTP server, real git clone/branch/diff, real test command,
// FAKE agent driver (no Anthropic call). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { buildServer } from "../src/server.js";
import type { AgentDriver } from "../src/agent.js";

const origin = mkdtempSync(join(tmpdir(), "origin-"));
let GIT_OK = true;
try {
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  writeFileSync(join(origin, "a.txt"), "hello\n");
  writeFileSync(join(origin, "test.sh"), "grep -q world a.txt\n");
  execFileSync("git", ["-C", origin, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { stdio: "ignore" });
} catch {
  GIT_OK = false; // some sandboxes forbid git writes; git-dependent tests are then skipped (reported as SKIP)
}
const gitSkip = GIT_OK ? false : "git write commands are blocked in this environment";

const fakeDriver = (delayMs = 0): AgentDriver => ({
  name: "fake",
  async run({ cwd, signal }) {
    await new Promise((r, j) => { const t = setTimeout(r, delayMs); signal.addEventListener("abort", () => { clearTimeout(t); j(new Error("aborted")); }); });
    writeFileSync(join(cwd, "a.txt"), "hello world\n");
    return { summary: "edited a.txt", usage: { provider: "anthropic", model: "fake", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null } };
  },
});

function settings(extra = {}) {
  return {
    port: 0, apiKey: "k".repeat(32), callbackSecret: "s".repeat(32), allowedCallbackOrigins: [],
    workRoot: mkdtempSync(join(tmpdir(), "work-")), dataRoot: mkdtempSync(join(tmpdir(), "data-")),
    maxConcurrentJobs: 2, maxTimeLimitSec: 600, maxLogBytes: 100000, agentModel: "fake", agentMaxTurns: 1,
    maxTokensCap: 1_000_000, maxCostUsdCap: 10,
    repos: [{ id: "demo", url: origin, defaultBranch: "main", testCommands: [["sh", "test.sh"]] }], ...extra,
  };
}

async function start(driver: AgentDriver, s = settings(), fetchImpl: typeof fetch = fetch) {
  const { server, jobs } = buildServer(s as any, driver, fetchImpl);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { Authorization: `Bearer ${s.apiKey}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  return { server, jobs, call, s };
}
const body = (extra = {}) => JSON.stringify({ task: "change a.txt", repositoryId: "demo", baseBranch: "main", runId: "11111111-1111-1111-1111-111111111111", stepId: "runner", allowedOperations: ["read", "write", "test"], timeLimitSec: 120, ...extra });
async function waitFor(call: any, id: string, pred: (s: string) => boolean) {
  for (let i = 0; i < 100; i++) { const j = await (await call(`/jobs/${id}`)).json(); if (pred(j.status)) return j; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("timeout");
}

test("rejects missing auth and unknown repository / path injection", async () => {
  const { server, call, s } = await start(fakeDriver());
  assert.equal((await fetch(`http://127.0.0.1:${(server.address() as any).port}/health`)).status, 401);
  const r = await call("/jobs", { method: "POST", headers: { "Idempotency-Key": "key-00000001" }, body: body({ repositoryId: "/etc" }) });
  assert.equal(r.status, 422);
  const r2 = await call("/jobs", { method: "POST", headers: { "Idempotency-Key": "key-00000002" }, body: body({ baseBranch: "--upload-pack=x" }) });
  assert.equal(r2.status, 422);
  server.close();
});

test("full lifecycle: clone → branch → agent → tests → diff; idempotent create", { skip: gitSkip }, async () => {
  const { server, call } = await start(fakeDriver(50));
  const r1 = await (await call("/jobs", { method: "POST", headers: { "Idempotency-Key": "run:step:1" }, body: body() })).json();
  const r2 = await (await call("/jobs", { method: "POST", headers: { "Idempotency-Key": "run:step:1" }, body: body() })).json();
  assert.equal(r1.jobId, r2.jobId);
  assert.equal(r2.duplicate, true);
  const done = await waitFor(call, r1.jobId, (s) => ["succeeded", "failed"].includes(s));
  assert.equal(done.status, "succeeded");
  assert.deepEqual(done.result.changedFiles, ["a.txt"]);
  assert.match(done.result.diff, /\+hello world/);
  assert.equal(done.result.testResults[0].exitCode, 0);
  assert.match(done.result.branch, /^agent\//);
  const art = await call(`/jobs/${r1.jobId}/artifact`);
  assert.match(await art.text(), /hello world/);
  // origin untouched: no push
  assert.equal(readFileSync(join(origin, "a.txt"), "utf8"), "hello\n");
  server.close();
});

test("cancel stops a running job", { skip: gitSkip }, async () => {
  const { server, call } = await start(fakeDriver(5000));
  const { jobId } = await (await call("/jobs", { method: "POST", headers: { "Idempotency-Key": "cancel-0001" }, body: body() })).json();
  await waitFor(call, jobId, (s) => s === "running");
  await new Promise((r) => setTimeout(r, 300));
  await call(`/jobs/${jobId}/cancel`, { method: "POST" });
  const j = await waitFor(call, jobId, (s) => ["cancelled", "failed", "succeeded"].includes(s));
  assert.equal(j.status, "cancelled");
  server.close();
});

test("time limit produces timed_out", { skip: gitSkip }, async () => {
  const s = settings({ maxTimeLimitSec: 1 });
  const { server, call } = await start(fakeDriver(5000), s as any);
  const { jobId } = await (await call("/jobs", { method: "POST", headers: { "Idempotency-Key": "timeout-001" }, body: body({ timeLimitSec: 1 }) })).json();
  const j = await waitFor(call, jobId, (st) => ["timed_out", "failed", "succeeded"].includes(st));
  assert.equal(j.status, "timed_out");
  server.close();
});

test("idempotent create returns same job (no git needed)", async () => {
  const { server, call } = await start(fakeDriver());
  const a = await (await call("/jobs", { method: "POST", headers: { "Idempotency-Key": "idem-00001" }, body: body() })).json();
  const b = await (await call("/jobs", { method: "POST", headers: { "Idempotency-Key": "idem-00001" }, body: body() })).json();
  assert.equal(a.jobId, b.jobId);
  assert.equal(b.duplicate, true);
  server.close();
});

test("queued job cancel is immediate", async () => {
  const { server, call } = await start(fakeDriver(), settings({ maxConcurrentJobs: 0 }) as any);
  const { jobId } = await (await call("/jobs", { method: "POST", headers: { "Idempotency-Key": "qcancel-01" }, body: body() })).json();
  const r = await (await call(`/jobs/${jobId}/cancel`, { method: "POST" })).json();
  assert.equal(r.status, "cancelled");
  server.close();
});

test("callbacks are HMAC-signed with increasing seq", async () => {
  const events: any[] = [];
  const s = settings();
  const fakeFetch: typeof fetch = async (_url, init: any) => {
    const ts = init.headers["X-Runner-Timestamp"], id = init.headers["X-Runner-Event-Id"];
    const expected = "v1=" + createHmac("sha256", s.callbackSecret).update(`${ts}.${id}.${init.body}`).digest("hex");
    assert.equal(init.headers["X-Runner-Signature"], expected);
    events.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  };
  const { server, call } = await start(fakeDriver(10), s as any, fakeFetch);
  const { jobId } = await (await call("/jobs", { method: "POST", headers: { "Idempotency-Key": "cb-000001" }, body: body({ callbackUrl: "https://app.example/api/public/runner-callback" }) })).json();
  const final = await waitFor(call, jobId, (st) => ["succeeded", "failed"].includes(st));
  await new Promise((r) => setTimeout(r, 300));
  const seqs = events.map((e) => e.seq);
  assert.ok(seqs.length >= 2);
  assert.deepEqual(new Set(seqs).size, seqs.length);
  assert.equal(Math.max(...seqs), final.seq);
  server.close();
});

test("restart recovery marks in-flight jobs failed", async () => {
  const s = settings();
  const jobId = "22222222-2222-2222-2222-222222222222";
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(s.dataRoot, "jobs"), { recursive: true });
  writeFileSync(join(s.dataRoot, "jobs", `${jobId}.json`), JSON.stringify({ id: jobId, idempotencyKey: "restart-01", request: JSON.parse(body()), status: "running", seq: 3, createdAt: "", startedAt: "", finishedAt: null, lastActivityAt: "", logs: [], logBytes: 0, result: null, error: null }));
  const b = await start(fakeDriver(), s as any);
  const j = await (await b.call(`/jobs/${jobId}`)).json();
  assert.equal(j.status, "failed");
  assert.match(j.error, /restarted/);
  b.server.close();

});

test("budget is parsed, clamped to configured caps and echoed in the result", async () => {
  const { validateRequest } = await import("../src/jobs.js");
  const s = settings() as any;
  const v = validateRequest(JSON.parse(body({ budget: { maxTokens: 9_999_999, maxCostUsd: 500 } })), s);
  assert.equal(v.error, undefined);
  assert.deepEqual(v.req!.budget, { maxTokens: s.maxTokensCap, maxCostUsd: s.maxCostUsdCap });
  const none = validateRequest(JSON.parse(body()), s);
  assert.deepEqual(none.req!.budget, { maxTokens: null, maxCostUsd: null });
  const bad = validateRequest(JSON.parse(body({ budget: { maxTokens: -5, maxCostUsd: "x" } })), s);
  assert.deepEqual(bad.req!.budget, { maxTokens: null, maxCostUsd: null });
});

test("driver budgetExceeded is reported without hiding produced artifacts", { skip: gitSkip }, async () => {
  const stoppedDriver: AgentDriver = {
    name: "fake-budget",
    async run({ cwd }) {
      writeFileSync(join(cwd, "a.txt"), "hello world\n");
      return { summary: "partial", usage: null, budgetExceeded: true, error: "token budget exceeded (10 > 5)" };
    },
  };
  const { server, call } = await start(stoppedDriver);
  const { jobId } = await (await call("/jobs", { method: "POST", headers: { "Idempotency-Key": "budget-001" }, body: body({ budget: { maxTokens: 5, maxCostUsd: null } }) })).json();
  const done = await waitFor(call, jobId, (st) => ["succeeded", "failed"].includes(st));
  assert.equal(done.result.budgetExceeded, true);
  assert.deepEqual(done.result.budget, { maxTokens: 5, maxCostUsd: null });
  assert.match(done.result.diff, /\+hello world/);
  assert.ok(done.result.errors.some((e: string) => /budget/.test(e)));
  server.close();
});

test("health advertises contract features and limits", async () => {
  const { server, call, s } = await start(fakeDriver());
  const h = await (await call("/health")).json();
  assert.ok(h.features.includes("budget"));
  assert.equal(h.limits.maxTokensCap, (s as any).maxTokensCap);
  server.close();
});

test("re-delivered callbacks keep one event id per seq (no duplicate side effects)", async () => {
  const seen = new Map<string, any>();
  const s = settings();
  const flaky: typeof fetch = async (_u, init: any) => {
    const id = init.headers["X-Runner-Event-Id"];
    const payload = JSON.parse(init.body);
    if (seen.has(id)) assert.deepEqual(seen.get(id), payload); // replay carries identical body
    seen.set(id, payload);
    return seen.size % 2 === 0 ? new Response("err", { status: 500 }) : new Response("{}", { status: 200 });
  };
  const { server, call } = await start(fakeDriver(10), s as any, flaky);
  const { jobId } = await (await call("/jobs", { method: "POST", headers: { "Idempotency-Key": "replay-01" }, body: body({ callbackUrl: "https://app.example/api/public/runner-callback" }) })).json();
  await waitFor(call, jobId, (st) => ["succeeded", "failed"].includes(st));
  await new Promise((r) => setTimeout(r, 500));
  const byJob = [...seen.values()].filter((e) => e.jobId === jobId);
  assert.deepEqual([...new Set(byJob.map((e) => e.seq))].length, byJob.length);
  server.close();
});
