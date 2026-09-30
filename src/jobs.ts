import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RunnerSettings, RepoConfig } from "./config.js";
import type { AgentDriver } from "./agent.js";
import { run, sandboxEnv, type ExecResult } from "./exec.js";

export type JobStatus = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "timed_out";
const TERMINAL: JobStatus[] = ["succeeded", "failed", "cancelled", "timed_out"];

export interface JobBudget {
  maxTokens: number | null;
  maxCostUsd: number | null;
}

export interface JobRequest {
  task: string;
  repositoryId: string;
  baseBranch: string;
  runId: string;
  stepId: string;
  allowedOperations: ("read" | "write" | "test")[];
  timeLimitSec: number;
  budget: JobBudget;
  callbackUrl?: string | null;
}

export interface CommandResult {
  phase: "setup" | "test";
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

export interface JobResult {
  status: JobStatus;
  summary: string | null;
  baseCommit: string | null;
  branch: string | null;
  changedFiles: string[];
  diff: string | null;
  artifactUrl: string | null;
  setupResults: CommandResult[];
  testResults: CommandResult[];
  errors: string[];
  durationMs: number;
  budget: JobBudget | null;
  budgetExceeded: boolean;
  usage: unknown;
}

export interface Job {
  id: string;
  idempotencyKey: string;
  request: JobRequest;
  status: JobStatus;
  seq: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastActivityAt: string;
  logs: string[];
  logBytes: number;
  result: JobResult | null;
  error: string | null;
}

export function validateRequest(body: any, settings: RunnerSettings): { req?: JobRequest; repo?: RepoConfig; error?: string } {
  if (!body || typeof body !== "object") return { error: "body must be an object" };
  const { task, repositoryId, baseBranch, runId, stepId, allowedOperations, timeLimitSec, budget, callbackUrl } = body;
  if (typeof task !== "string" || !task.trim() || task.length > 20000) return { error: "task is required (≤20000 chars)" };
  if (typeof repositoryId !== "string") return { error: "repositoryId is required" };
  const repo = settings.repos.find((r) => r.id === repositoryId);
  if (!repo) return { error: `unknown repositoryId; allowed: ${settings.repos.map((r) => r.id).join(", ")}` };
  const branch = typeof baseBranch === "string" && baseBranch ? baseBranch : repo.defaultBranch;
  if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(branch) || branch.includes("..") || branch.startsWith("-")) return { error: "invalid baseBranch" };
  if (typeof runId !== "string" || !/^[0-9a-f-]{36}$/i.test(runId)) return { error: "runId must be a uuid" };
  if (typeof stepId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(stepId)) return { error: "invalid stepId" };
  const ops = Array.isArray(allowedOperations) ? allowedOperations.filter((o: string) => ["read", "write", "test"].includes(o)) : [];
  const repoOps = repo.allowedOperations ?? ["read", "write", "test"];
  const effective = ops.filter((o: any) => repoOps.includes(o));
  if (effective.length === 0) return { error: "no allowed operations" };
  const limit = Math.min(Math.max(Number(timeLimitSec) || 1800, 60), settings.maxTimeLimitSec);
  const num = (v: unknown, max: number): number | null => {
    if (v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(n, max);
  };
  const b = budget && typeof budget === "object" ? (budget as any) : {};
  const jobBudget: JobBudget = {
    maxTokens: num(b.maxTokens, settings.maxTokensCap),
    maxCostUsd: num(b.maxCostUsd, settings.maxCostUsdCap),
  };
  let cb: string | null = null;
  if (callbackUrl != null) {
    try {
      const u = new URL(String(callbackUrl));
      const loopback = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
      if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return { error: "callbackUrl must be https" };
      if (settings.allowedCallbackOrigins.length && !settings.allowedCallbackOrigins.includes(u.origin))
        return { error: "callbackUrl origin not allowed" };
      cb = u.toString();
    } catch {
      return { error: "invalid callbackUrl" };
    }
  }
  return {
    req: { task, repositoryId, baseBranch: branch, runId, stepId, allowedOperations: effective, timeLimitSec: limit, budget: jobBudget, callbackUrl: cb },
    repo,
  };
}

export class JobManager {
  jobs = new Map<string, Job>();
  byKey = new Map<string, string>();
  controllers = new Map<string, AbortController>();
  queue: string[] = [];
  running = 0;

  constructor(private settings: RunnerSettings, private driver: AgentDriver, private fetchImpl: typeof fetch = fetch) {
    mkdirSync(join(settings.dataRoot, "jobs"), { recursive: true });
    mkdirSync(join(settings.dataRoot, "artifacts"), { recursive: true });
    mkdirSync(settings.workRoot, { recursive: true });
    this.recover();
  }

  /** On restart: in-flight jobs cannot be resumed safely → failed with an explicit reason. */
  private recover() {
    const dir = join(this.settings.dataRoot, "jobs");
    for (const f of readdirSync(dir)) {
      try {
        const job = JSON.parse(readFileSync(join(dir, f), "utf8")) as Job;
        this.jobs.set(job.id, job);
        this.byKey.set(job.idempotencyKey, job.id);
        if (!TERMINAL.includes(job.status)) {
          const wasCancelling = job.status === "cancelling";
          this.finish(job, wasCancelling ? "cancelled" : "failed", wasCancelling ? null : "runner restarted while job was in progress; working copy discarded");
          rmSync(join(this.settings.workRoot, job.id), { recursive: true, force: true });
        }
      } catch {
        /* skip corrupt file */
      }
    }
  }

  private persist(job: Job) {
    writeFileSync(join(this.settings.dataRoot, "jobs", `${job.id}.json`), JSON.stringify(job));
  }

  private log(job: Job, line: string) {
    job.lastActivityAt = new Date().toISOString();
    if (job.logBytes > this.settings.maxLogBytes) return;
    const l = line.slice(0, 4000);
    job.logBytes += l.length;
    job.logs.push(job.logBytes > this.settings.maxLogBytes ? "[log limit reached]" : l);
  }

  /** Idempotent create: same Idempotency-Key returns the existing job. */
  create(req: JobRequest, idempotencyKey: string): { job: Job; created: boolean } {
    const existing = this.byKey.get(idempotencyKey);
    if (existing) return { job: this.jobs.get(existing)!, created: false };
    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(), idempotencyKey, request: req, status: "queued", seq: 1,
      createdAt: now, startedAt: null, finishedAt: null, lastActivityAt: now, logs: [], logBytes: 0, result: null, error: null,
    };
    this.jobs.set(job.id, job);
    this.byKey.set(idempotencyKey, job.id);
    this.persist(job);
    this.queue.push(job.id);
    void this.emit(job);
    this.pump();
    return { job, created: true };
  }

  cancel(id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (TERMINAL.includes(job.status)) return job;
    if (job.status === "queued") {
      this.queue = this.queue.filter((q) => q !== id);
      this.finish(job, "cancelled", null);
      return job;
    }
    this.setStatus(job, "cancelling");
    this.controllers.get(id)?.abort();
    return job;
  }

  private setStatus(job: Job, status: JobStatus) {
    if (TERMINAL.includes(job.status)) return;
    job.status = status;
    job.seq += 1;
    job.lastActivityAt = new Date().toISOString();
    this.persist(job);
    void this.emit(job);
  }

  private finish(job: Job, status: JobStatus, error: string | null, result?: JobResult) {
    if (TERMINAL.includes(job.status)) return;
    job.status = status;
    job.seq += 1;
    job.error = error;
    job.finishedAt = new Date().toISOString();
    job.result = result ?? {
      status, summary: null, baseCommit: null, branch: null, changedFiles: [], diff: null, artifactUrl: null,
      setupResults: [], testResults: [], errors: error ? [error] : [], durationMs: 0,
      budget: job.request.budget ?? null, budgetExceeded: false, usage: null,
    };
    job.result.status = status;
    this.persist(job);
    void this.emit(job);
  }

  private pump() {
    while (this.running < this.settings.maxConcurrentJobs && this.queue.length) {
      const id = this.queue.shift()!;
      const job = this.jobs.get(id);
      if (!job || job.status !== "queued") continue;
      this.running++;
      this.execute(job).finally(() => {
        this.running--;
        this.controllers.delete(job.id);
        this.pump();
      });
    }
  }

  private async execute(job: Job) {
    const s = this.settings;
    const repo = s.repos.find((r) => r.id === job.request.repositoryId)!;
    const ctrl = new AbortController();
    this.controllers.set(job.id, ctrl);
    let deadlineHit = false;
    const deadline = setTimeout(() => {
      deadlineHit = true;
      ctrl.abort(new Error("timeout"));
    }, job.request.timeLimitSec * 1000);

    const heartbeat = setInterval(() => this.setStatus(job, job.status), 30_000);
    const dir = join(s.workRoot, job.id);
    const started = Date.now();
    const errors: string[] = [];
    const token = repo.tokenEnv ? process.env[repo.tokenEnv] ?? "" : "";
    const gitEnv = sandboxEnv();
    const sh = (argv: string[], timeoutMs = 120_000, env = gitEnv) =>
      run(argv, { cwd: dir, timeoutMs, maxBytes: 200_000, signal: ctrl.signal, env, redact: [token] });
    let baseCommit: string | null = null;
    const branch = `agent/${job.id.slice(0, 8)}`;
    try {
      job.startedAt = new Date().toISOString();
      this.setStatus(job, "running");
      mkdirSync(dir, { recursive: true });
      // 1. isolated working copy (token passed as a one-off header, never written to .git/config)
      const auth = token ? ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`] : [];
      const clone = await run(["git", ...auth, "clone", "--depth", "50", "--branch", job.request.baseBranch, "--", repo.url, dir], {
        cwd: s.workRoot, timeoutMs: 300_000, maxBytes: 100_000, signal: ctrl.signal, env: gitEnv, redact: [token],
      });
      if (clone.exitCode !== 0) throw new Error(`git clone failed: ${clone.stderr.slice(0, 500)}`);
      baseCommit = (await sh(["git", "rev-parse", "HEAD"])).stdout.trim();
      // 2. separate branch
      await sh(["git", "checkout", "-b", branch]);
      this.log(job, `cloned ${repo.id}@${job.request.baseBranch} (${baseCommit}) → ${branch}`);
      const setupResults: CommandResult[] = [];
      for (const cmd of repo.setupCommands ?? []) {
        const r = await sh(cmd, 600_000);
        setupResults.push({ phase: "setup", command: r.command, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, output: (r.stdout + "\n" + r.stderr).slice(-20_000) });
        this.log(job, `setup: ${r.command} → ${r.exitCode}`);
        if (r.exitCode !== 0) throw new Error(`setup command failed: ${r.command} (exit ${r.exitCode})`);
      }
      // 3. agent (file tools only, budget enforced by the driver)
      const outcome = await this.driver.run({
        task: job.request.task, cwd: dir, allowedOperations: job.request.allowedOperations,
        model: s.agentModel, maxTurns: s.agentMaxTurns, budget: job.request.budget ?? { maxTokens: null, maxCostUsd: null },
        signal: ctrl.signal, log: (l) => this.log(job, l),
      });
      if (outcome.error) errors.push(outcome.error);
      if (outcome.budgetExceeded) this.log(job, "budget limit reached: agent stopped early");
      if (ctrl.signal.aborted) throw ctrl.signal.reason ?? new Error("aborted");
      // 4. tests (argv from repo config only)
      const testResults: CommandResult[] = [];
      if (job.request.allowedOperations.includes("test")) {
        for (const cmd of repo.testCommands ?? []) {
          const r: ExecResult = await sh(cmd, Math.max(60_000, job.request.timeLimitSec * 500));
          testResults.push({ phase: "test", command: r.command, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, output: (r.stdout + "\n" + r.stderr).slice(-20_000) });
          this.log(job, `test: ${r.command} → ${r.exitCode}`);
        }
      }
      // 5. diff + artifact (kept after working copy removal); no push, no merge
      await sh(["git", "add", "-A"]);
      const diff = (await run(["git", "diff", "--cached", baseCommit], { cwd: dir, timeoutMs: 60_000, maxBytes: 5_000_000, env: gitEnv })).stdout;
      const changed = (await sh(["git", "diff", "--cached", "--name-only", baseCommit])).stdout.split("\n").filter(Boolean);
      writeFileSync(join(s.dataRoot, "artifacts", `${job.id}.patch`), diff);
      const status: JobStatus = errors.length && !diff ? "failed" : "succeeded";
      this.finish(job, status, errors[0] ?? null, {
        status, summary: outcome.summary || null, baseCommit, branch, changedFiles: changed,
        diff: diff.length > 500_000 ? diff.slice(0, 500_000) : diff, artifactUrl: `/jobs/${job.id}/artifact`,
        setupResults, testResults, errors, durationMs: Date.now() - started,
        budget: job.request.budget ?? null, budgetExceeded: Boolean(outcome.budgetExceeded), usage: outcome.usage,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // The time limit aborts the running child process, so the surfacing error is
      // usually the command failure, not "timeout" — classify by the deadline flag.
      const reasonIsTimeout =
        (ctrl.signal.reason instanceof Error && ctrl.signal.reason.message === "timeout") || ctrl.signal.reason === "timeout";
      const timedOut = deadlineHit || reason === "timeout" || reasonIsTimeout;
      const cancelled = job.status === "cancelling" && !timedOut;
      const finalStatus: JobStatus = timedOut ? "timed_out" : cancelled ? "cancelled" : "failed";
      this.finish(job, finalStatus, cancelled ? null : reason, {
        status: finalStatus, summary: null, baseCommit, branch, changedFiles: [], diff: null, artifactUrl: null,
        setupResults: [], testResults: [], errors: cancelled ? [] : [reason], durationMs: Date.now() - started,
        budget: job.request.budget ?? null, budgetExceeded: false, usage: null,
      });

    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      rmSync(dir, { recursive: true, force: true }); // 7. release resources
    }
  }

  artifactPath(id: string): string | null {
    const p = join(this.settings.dataRoot, "artifacts", `${id}.patch`);
    return existsSync(p) ? p : null;
  }

  public view(job: Job) {
    return { jobId: job.id, status: job.status, seq: job.seq, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, lastActivityAt: job.lastActivityAt, error: job.error, result: TERMINAL.includes(job.status) ? job.result : undefined };
  }

  /** Signed status callback with bounded retries. Failures are tolerated: the app polls as fallback. */
  private async emit(job: Job) {
    const url = job.request.callbackUrl;
    const secret = this.settings.callbackSecret;
    if (!url || !secret) return;
    const eventId = randomUUID();
    const body = JSON.stringify({
      eventId, jobId: job.id, runId: job.request.runId, stepId: job.request.stepId, seq: job.seq, status: job.status,
      ...(TERMINAL.includes(job.status) ? { result: job.result, error: job.error } : {}),
    });
    for (let attempt = 0; attempt < 4; attempt++) {
      const ts = String(Math.floor(Date.now() / 1000));
      const signature = "v1=" + createHmac("sha256", secret).update(`${ts}.${eventId}.${body}`).digest("hex");
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Runner-Timestamp": ts, "X-Runner-Event-Id": eventId, "X-Runner-Signature": signature },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return;
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}
