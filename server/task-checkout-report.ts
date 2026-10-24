import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface CheckoutReport { found: string[]; incomplete: boolean; artifact?: string }

export function reportTaskCheckouts(workspace: string, maxEntries = 20_000, approvedRoot?: string): CheckoutReport {
  if (!lstatSync(workspace).isDirectory() ||
    (approvedRoot && !realpathSync(workspace).startsWith(realpathSync(approvedRoot) + sep))) {
    throw new Error("Task workspace is not a directory within the workspace root");
  }
  const found: string[] = [];
  const pending: Array<{ dir: string; depth: number }> = [{ dir: workspace, depth: 0 }];
  let visited = 0;
  let incomplete = false;
  while (pending.length) {
    const next = pending.pop()!;
    let entries;
    try { entries = readdirSync(next.dir, { withFileTypes: true }); }
    catch { incomplete = true; continue; }
    for (const entry of entries) {
      if (++visited > maxEntries) { incomplete = true; break; }
      if (entry.name === "artefacts" && next.depth === 0) continue;
      const path = join(next.dir, entry.name);
      if (entry.name === ".git") {
        if (entry.isDirectory() || entry.isFile()) found.push(relative(workspace, path));
      } else if (entry.isDirectory()) {
        if (next.depth < 12) pending.push({ dir: path, depth: next.depth + 1 });
        else incomplete = true;
      } else if (entry.isSymbolicLink()) {
        try { if (lstatSync(path).isSymbolicLink()) continue; }
        catch { incomplete = true; }
      }
    }
    if (visited > maxEntries) break;
  }
  const report: CheckoutReport = { found: found.sort(), incomplete };
  if (found.length || incomplete) {
    const artifacts = join(workspace, "artefacts");
    if (existsSync(artifacts)) {
      if (!lstatSync(artifacts).isDirectory()) throw new Error("Task artefacts path is not a directory");
    } else mkdirSync(artifacts, { mode: 0o700 });
    report.artifact = join(artifacts, `checkout-report-${randomUUID()}.json`);
    writeFileSync(report.artifact, JSON.stringify({ ...report, recordedAt: new Date().toISOString() }, null, 2), { flag: "wx", mode: 0o600 });
  }
  return report;
}
