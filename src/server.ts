import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { timingSafeEqual, createHash } from "node:crypto";
import { loadSettings, type RunnerSettings } from "./config.js";
import { claudeAgentSdkDriver, type AgentDriver } from "./agent.js";
import { JobManager, validateRequest } from "./jobs.js";

export const VERSION = "1.0.0";
export const CONTRACT_VERSION = "1";

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, max = 100_000): Promise<string> {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > max) throw new Error("body too large");
  }
  return data;
}

function authorized(req: IncomingMessage, key: string): boolean {
  const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
  if (!token) return false;
  const h = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(h(token), h(key));
}

export function buildServer(settings: RunnerSettings, driver: AgentDriver = claudeAgentSdkDriver, fetchImpl: typeof fetch = fetch) {
  const jobs = new JobManager(settings, driver, fetchImpl);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://runner");
      const parts = url.pathname.split("/").filter(Boolean);
      if (!authorized(req, settings.apiKey)) return send(res, 401, { error: "unauthorized" });

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, {
          ok: true, version: VERSION, contractVersion: CONTRACT_VERSION, agentDriver: driver.name,
          features: ["budget", "setup-results", "artifacts"],
          anthropicKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
          limits: { maxTimeLimitSec: settings.maxTimeLimitSec, maxTokensCap: settings.maxTokensCap, maxCostUsdCap: settings.maxCostUsdCap },
          repositories: settings.repos.map((r) => ({ id: r.id, defaultBranch: r.defaultBranch, tests: (r.testCommands ?? []).length })),
          activeJobs: jobs.running, queuedJobs: jobs.queue.length,
        });
      }
      if (req.method === "POST" && url.pathname === "/jobs") {
        const key = String(req.headers["idempotency-key"] ?? "");
        if (!/^[A-Za-z0-9:_-]{8,200}$/.test(key)) return send(res, 400, { error: "Idempotency-Key header required" });
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return send(res, 400, { error: "invalid JSON" });
        }
        const v = validateRequest(body, settings);
        if (v.error) return send(res, 422, { error: v.error });
        const { job, created } = jobs.create(v.req!, key);
        return send(res, created ? 202 : 200, { jobId: job.id, status: job.status, seq: job.seq, duplicate: !created });
      }
      if (parts[0] === "jobs" && parts[1]) {
        const job = jobs.jobs.get(parts[1]);
        if (!job) return send(res, 404, { error: "job not found" });
        if (req.method === "GET" && parts.length === 2) return send(res, 200, jobs.view(job));
        if (req.method === "POST" && parts[2] === "cancel") {
          const j = jobs.cancel(job.id)!;
          return send(res, 200, { jobId: j.id, status: j.status, seq: j.seq });
        }
        if (req.method === "GET" && parts[2] === "result") {
          if (!job.result) return send(res, 409, { error: "job not finished", status: job.status });
          return send(res, 200, job.result);
        }
        if (req.method === "GET" && parts[2] === "logs") return send(res, 200, { logs: job.logs });
        if (req.method === "GET" && parts[2] === "artifact") {
          const p = jobs.artifactPath(job.id);
          if (!p) return send(res, 404, { error: "no artifact" });
          res.writeHead(200, { "Content-Type": "text/x-diff", "Content-Disposition": `attachment; filename="${job.id}.patch"` });
          return createReadStream(p).pipe(res);
        }
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      return send(res, 500, { error: e instanceof Error ? e.message : "internal error" });
    }
  });
  return { server, jobs };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  const settings = loadSettings();
  const { server } = buildServer(settings);
  server.listen(settings.port, () => console.log(`agent-control runner v${VERSION} listening on :${settings.port}`));
}
