/**
 * Agent drivers. Default: Claude Agent SDK, restricted to file tools inside the job workdir.
 * Shell/Bash, web and MCP tools are never enabled — tests are run by the runner itself from repo config.
 */
export interface AgentUsage {
  provider: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
}

export interface AgentOutcome {
  summary: string;
  usage: AgentUsage | null;
  error?: string;
  budgetExceeded?: boolean;
}

export interface AgentBudget {
  maxTokens: number | null;
  maxCostUsd: number | null;
}

export interface AgentDriver {
  name: string;
  run(params: {
    task: string;
    cwd: string;
    allowedOperations: string[];
    model: string;
    maxTurns: number;
    budget: AgentBudget;
    signal: AbortSignal;
    log: (line: string) => void;
  }): Promise<AgentOutcome>;
}

export function toolsFor(ops: string[]): string[] {
  const tools: string[] = [];
  if (ops.includes("read") || ops.includes("write")) tools.push("Read", "Glob", "Grep");
  if (ops.includes("write")) tools.push("Edit", "Write");
  return tools;
}

export const claudeAgentSdkDriver: AgentDriver = {
  name: "claude-agent-sdk",
  async run({ task, cwd, allowedOperations, model, maxTurns, budget, signal, log }) {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const allowedTools = toolsFor(allowedOperations);
    const abortController = new AbortController();
    signal.addEventListener("abort", () => abortController.abort(), { once: true });
    const prompt = [
      "Ты работаешь в изолированной рабочей копии git-репозитория.",
      "Выполни задание, изменяя только файлы внутри текущего каталога. Не выполняй команды, не делай commit/push.",
      allowedOperations.includes("write") ? "" : "Изменение файлов запрещено: только анализ.",
      "В конце кратко опиши сделанные изменения.",
      "",
      "Задание:",
      task,
    ].join("\n");
    let summary = "";
    let usage: AgentUsage | null = null;
    let error: string | undefined;
    let budgetExceeded = false;
    let spentTokens = 0;
    const stream = query({
      prompt,
      options: {
        cwd,
        model,
        maxTurns,
        allowedTools,
        disallowedTools: ["Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch", "Task", "NotebookEdit"],
        permissionMode: "dontAsk" as any,
        settingSources: [],
        abortController,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp/jobhome", ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" },
      } as any,
    });
    for await (const msg of stream as AsyncIterable<any>) {
      if (msg.type === "assistant") {
        for (const block of msg.message?.content ?? []) if (block.type === "text") log(`[agent] ${String(block.text).slice(0, 500)}`);
        const mu = msg.message?.usage ?? {};
        spentTokens += (mu.input_tokens ?? 0) + (mu.output_tokens ?? 0);
        if (budget.maxTokens && spentTokens > budget.maxTokens && !budgetExceeded) {
          budgetExceeded = true;
          error = `token budget exceeded (${spentTokens} > ${budget.maxTokens})`;
          log(`[budget] ${error}; stopping agent`);
          abortController.abort();
        }
      } else if (msg.type === "result") {
        summary = msg.result ?? summary;
        if (msg.subtype !== "success" && !budgetExceeded) error = `agent finished: ${msg.subtype}`;
        const u = msg.usage ?? {};
        usage = {
          provider: "anthropic",
          model,
          inputTokens: u.input_tokens ?? null,
          outputTokens: u.output_tokens ?? null,
          cacheReadTokens: u.cache_read_input_tokens ?? null,
          cacheWriteTokens: u.cache_creation_input_tokens ?? null,
          costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null,
        };
        if (budget.maxCostUsd && usage.costUsd != null && usage.costUsd > budget.maxCostUsd) {
          budgetExceeded = true;
          error = `cost budget exceeded (${usage.costUsd} > ${budget.maxCostUsd} USD)`;
          log(`[budget] ${error}`);
        }
      }
    }
    return { summary, usage, budgetExceeded, ...(error ? { error } : {}) };
  },
};
