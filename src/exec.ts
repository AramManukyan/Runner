import { spawn } from "node:child_process";

export interface ExecResult {
  command: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  timedOut: boolean;
}

/** Minimal environment for child processes: no runner secrets, no host credentials. */
export function sandboxEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp/jobhome",
    LANG: "C.UTF-8",
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

/** Runs argv without a shell, with timeout, abort signal and output cap. */
export function run(
  argv: string[],
  opts: { cwd: string; timeoutMs: number; maxBytes: number; signal?: AbortSignal; env?: Record<string, string>; redact?: string[] },
): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd!, args, { cwd: opts.cwd, env: opts.env ?? sandboxEnv(), shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", truncated = false, timedOut = false;
    const cap = (cur: string, chunk: Buffer) => {
      if (cur.length + chunk.length > opts.maxBytes) {
        truncated = true;
        return cur + chunk.toString("utf8").slice(0, Math.max(0, opts.maxBytes - cur.length));
      }
      return cur + chunk.toString("utf8");
    };
    child.stdout.on("data", (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = cap(stderr, c)));
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    opts.signal?.addEventListener("abort", kill, { once: true });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const redact = (s: string) => (opts.redact ?? []).reduce((acc, r) => (r ? acc.split(r).join("***") : acc), s);
      resolve({
        command: argv.join(" "),
        exitCode: code,
        signal,
        stdout: redact(stdout),
        stderr: redact(stderr),
        truncated,
        durationMs: Date.now() - started,
        timedOut,
      });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ command: argv.join(" "), exitCode: null, signal: null, stdout, stderr: String(e), truncated, durationMs: Date.now() - started, timedOut });
    });
  });
}
