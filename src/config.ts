import { readFileSync } from "node:fs";

export interface RepoConfig {
  id: string;
  /** https clone URL; token (if any) is taken from env var named in tokenEnv, never from the request */
  url: string;
  tokenEnv?: string;
  defaultBranch: string;
  /** Commands as argv arrays — executed WITHOUT a shell. Never supplied by the API caller. */
  setupCommands?: string[][];
  testCommands?: string[][];
  /** Operations this repository allows at most (intersected with the request). */
  allowedOperations?: ("read" | "write" | "test")[];
}

export interface RunnerSettings {
  port: number;
  apiKey: string;
  callbackSecret: string | null;
  allowedCallbackOrigins: string[];
  workRoot: string;
  dataRoot: string;
  maxConcurrentJobs: number;
  maxTimeLimitSec: number;
  maxLogBytes: number;
  agentModel: string;
  agentMaxTurns: number;
  /** Upper bounds for the per-job budget requested by the app. */
  maxTokensCap: number;
  maxCostUsdCap: number;
  repos: RepoConfig[];
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export function loadSettings(): RunnerSettings {
  let repos: RepoConfig[] = [];
  if (process.env.REPOS_JSON) {
    try {
      repos = JSON.parse(process.env.REPOS_JSON) as RepoConfig[];
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Invalid REPOS_JSON env var: ${msg}`);
    }
  } else {
    const reposPath = process.env.REPOS_CONFIG ?? "/config/repos.json";
    repos = JSON.parse(readFileSync(reposPath, "utf8")) as RepoConfig[];
  }
  for (const r of repos) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(r.id)) throw new Error(`Invalid repository id ${r.id}`);
    if (!/^https:\/\//.test(r.url)) throw new Error(`Repository ${r.id}: only https URLs are allowed`);
  }
  return {
    port: Number(process.env.PORT ?? 8787),
    apiKey: need("RUNNER_API_KEY"),
    callbackSecret: process.env.RUNNER_CALLBACK_SECRET ?? null,
    allowedCallbackOrigins: (process.env.ALLOWED_CALLBACK_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    workRoot: process.env.WORK_ROOT ?? "/work",
    dataRoot: process.env.DATA_ROOT ?? "/data",
    maxConcurrentJobs: Number(process.env.MAX_CONCURRENT_JOBS ?? 2),
    maxTimeLimitSec: Number(process.env.MAX_TIME_LIMIT_SEC ?? 3600),
    maxLogBytes: Number(process.env.MAX_LOG_BYTES ?? 1_000_000),
    agentModel: process.env.AGENT_MODEL ?? "claude-sonnet-4-5",
    agentMaxTurns: Number(process.env.AGENT_MAX_TURNS ?? 40),
    maxTokensCap: Number(process.env.MAX_TOKENS_CAP ?? 2_000_000),
    maxCostUsdCap: Number(process.env.MAX_COST_USD_CAP ?? 20),
    repos,
  };
}
