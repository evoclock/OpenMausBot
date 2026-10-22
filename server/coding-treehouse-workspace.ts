import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunContractInput } from "./run-contract.ts";
import type { IsolatedWorkspace } from "./inner-worker-route.ts";

interface Slot {
  path: string;
  status: string;
  lease_id?: string;
  lease_holder?: string;
}

export class CodingTreehouseWorkspace {
  private readonly db: DatabaseSync;
  private readonly root: string;
  constructor(options: { repository: string; root: string; dataDir: string; executable?: string }) {
    this.repository = options.repository;
    this.root = realpathSync(options.root);
    this.executable = options.executable ?? "treehouse";
    mkdirSync(options.dataDir, { recursive: true });
    this.db = new DatabaseSync(join(options.dataDir, "coding-workspaces.sqlite"));
    this.db.exec("CREATE TABLE IF NOT EXISTS coding_workspaces (request_id TEXT PRIMARY KEY, contract TEXT NOT NULL, path TEXT, lease_id TEXT)");
  }
  private readonly repository: string;
  private readonly executable: string;
  close() { this.db.close(); }
  private call(...args: string[]): string {
    return execFileSync(this.executable, args, { cwd: this.root, encoding: "utf8", timeout: 30_000,
      maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  }
  private slots(): Slot[] { return JSON.parse(this.call("status", "--json")) as Slot[]; }
  async acquire(contract: RunContractInput, requestId: string): Promise<IsolatedWorkspace> {
    if (!requestId || contract.repository !== this.repository || contract.repositoryClass !== "agent-private" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,128}$/.test(contract.ref) ||
      contract.ref.includes("..") || contract.ref.includes("//") || contract.ref.endsWith(".")) {
      throw new Error("workspace repository or request is not approved");
    }
    const identity = JSON.stringify(contract);
    const holder = `omb-coding-${createHash("sha256").update(requestId).digest("hex").slice(0, 24)}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR IGNORE INTO coding_workspaces (request_id, contract) VALUES (?, ?)").run(requestId, identity);
      const row = this.db.prepare("SELECT contract, path, lease_id FROM coding_workspaces WHERE request_id = ?")
        .get(requestId) as { contract: string; path: string | null; lease_id: string | null };
      if (row.contract !== identity) throw new Error("workspace request conflicts with its original contract");
      const matching = this.slots().filter((slot) => slot.status === "leased" && slot.lease_holder === holder);
      if (matching.length > 1) throw new Error("multiple leased workspaces match the coding request");
      let slot: Slot | undefined = matching[0];
      if (!slot && row.lease_id) throw new Error("recorded workspace lease was lost");
      if (!slot) {
        const acquired = JSON.parse(this.call("get", "--lease", "--base", contract.ref,
          "--lease-holder", holder, "--json")) as { path: string; lease_id: string };
        slot = this.slots().find((candidate) => candidate.path === acquired.path &&
          candidate.lease_id === acquired.lease_id && candidate.lease_holder === holder);
      }
      if (!slot?.lease_id || realpathSync(slot.path) === this.root ||
        this.gitCommonDir(slot.path) !== this.gitCommonDir(this.root)) {
        throw new Error("Treehouse lease could not be verified");
      }
      if (row.path && row.path !== slot.path || row.lease_id && row.lease_id !== slot.lease_id) {
        throw new Error("workspace lease changed for the same request");
      }
      this.db.prepare("UPDATE coding_workspaces SET path = ?, lease_id = ? WHERE request_id = ?")
        .run(slot.path, slot.lease_id, requestId);
      this.db.exec("COMMIT");
      return { repository: contract.repository, directory: slot.path, branch: contract.ref,
        base: contract.ref, leaseId: slot.lease_id };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private gitCommonDir(path: string): string {
    const output = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: path, encoding: "utf8", timeout: 10_000 }).trim();
    return realpathSync(resolve(path, output));
  }
  async release(leaseId: string): Promise<void> {
    if (!this.slots().some((slot) => slot.lease_id === leaseId && slot.status === "leased")) {
      throw new Error("workspace lease cannot be verified for release");
    }
    throw new Error("coding workspace release requires reconciliation; lease retained");
  }
}
