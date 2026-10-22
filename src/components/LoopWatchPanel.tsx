import { useEffect, useState } from "react";

type LoopRun = {
  id: string; state: string; iteration: number; lastVerdict: string | null;
  budget: { iterationsUsed: number; iterationsRemaining: number; spentUsd: number;
    spendRemainingUsd: number | null; spendUncertain: boolean; elapsedMs: number; wallTimeRemainingMs: number | null };
  entries: Array<{ iteration: number; state: string; at: number; verdict: string | null }>;
};

export function LoopWatchPanel({ botId }: { botId: string }) {
  const [runs, setRuns] = useState<LoopRun[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    async function refresh() {
      try {
        const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/loop-status`, { signal: controller.signal });
        if (!response.ok) throw new Error("loop status unavailable");
        const result = (await response.json()) as { runs: LoopRun[] };
        if (!controller.signal.aborted) { setRuns(result.runs); setError(false); }
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [botId]);
  return <section aria-label="Loop watch" className="border-b border-hairline/40 px-4 py-3 text-sm">
    <h2 className="font-semibold">Loop watch</h2>
    {error && <p role="status">Loop status unavailable</p>}
    {!error && runs.length === 0 && <p>No loop runs</p>}
    {runs.map((run) => <article key={run.id} className="py-2">
      <p>{run.state} · iteration {run.iteration} · last verdict {run.lastVerdict ?? "pending"}</p>
      <p>Iterations: {run.budget.iterationsUsed} used, {run.budget.iterationsRemaining} remaining</p>
      <p>Spend: ${run.budget.spentUsd.toFixed(2)} used, {run.budget.spendRemainingUsd === null ? "unknown" : `$${run.budget.spendRemainingUsd.toFixed(2)}`} remaining</p>
      <p>Time: {Math.round(run.budget.elapsedMs / 1000)}s used, {run.budget.wallTimeRemainingMs === null ? "unknown" : `${Math.round(run.budget.wallTimeRemainingMs / 1000)}s`} remaining</p>
      <ul>{run.entries.map((entry) => <li key={entry.iteration}>#{entry.iteration}: {entry.state}</li>)}</ul>
    </article>)}
  </section>;
}
