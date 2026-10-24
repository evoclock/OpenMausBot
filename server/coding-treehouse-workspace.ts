import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, lstatSync, mkdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  constructor(options: { repository: string; root: string; dataDir: string; executable?: string;
    gitExecutable?: string; salvageDir?: string;
    verifyRepository?: (repository: string, root: string) => boolean;
    verifySlot?: (path: string) => boolean;
    readRevision?: (path: string, ref: string) => string;
    readStatus?: (path: string) => string }) {
    this.repository = options.repository;
    this.root = realpathSync(options.root);
    this.executable = options.executable ?? "treehouse";
    this.gitExecutable = options.gitExecutable ?? "git";
    this.salvageDir = options.salvageDir ?? join(homedir(), ".treehouse-salvage", "openai-work");
    this.verifySlot = options.verifySlot ?? ((path) => this.gitCommonDir(path) === this.gitCommonDir(this.root));
    this.readRevision = options.readRevision ?? ((path, ref) => execFileSync(this.gitExecutable, ["rev-parse", ref],
      { cwd: path, encoding: "utf8", timeout: 10_000 }).trim());
    this.readStatus = options.readStatus ?? ((path) => execFileSync(this.gitExecutable, ["status", "--porcelain", "--untracked-files=all"],
      { cwd: path, encoding: "utf8", timeout: 10_000 }).trim());
    this.verifyRepository = options.verifyRepository ?? ((repository, root) => {
      const result = JSON.parse(execFileSync("gh", ["repo", "view", repository,
        "--json", "nameWithOwner,isPrivate,viewerPermission"],
      { cwd: root, encoding: "utf8", timeout: 15_000 })) as {
        nameWithOwner?: string; isPrivate?: boolean; viewerPermission?: string };
      const origin = execFileSync(this.gitExecutable, ["remote", "get-url", "origin"],
        { cwd: root, encoding: "utf8", timeout: 10_000 }).trim();
      return result.nameWithOwner === repository && result.isPrivate === true &&
        ["ADMIN", "MAINTAIN", "WRITE"].includes(result.viewerPermission ?? "") &&
        (origin === `git@github.com:${repository}.git` || origin === `https://github.com/${repository}.git`);
    });
    mkdirSync(options.dataDir, { recursive: true });
    this.db = new DatabaseSync(join(options.dataDir, "coding-workspaces.sqlite"));
    this.db.exec("CREATE TABLE IF NOT EXISTS coding_workspaces (request_id TEXT PRIMARY KEY, contract TEXT NOT NULL, path TEXT, lease_id TEXT, base_sha TEXT)");
    const columns = this.db.prepare("PRAGMA table_info(coding_workspaces)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "base_sha")) this.db.exec("ALTER TABLE coding_workspaces ADD COLUMN base_sha TEXT");
  }
  private readonly repository: string;
  private readonly executable: string;
  private readonly gitExecutable: string;
  private readonly salvageDir: string;
  private readonly verifyRepository: (repository: string, root: string) => boolean;
  private readonly verifySlot: (path: string) => boolean;
  private readonly readRevision: (path: string, ref: string) => string;
  private readonly readStatus: (path: string) => string;
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
    if (!this.verifyRepository(this.repository, this.root)) throw new Error("private coding repository is not verified");
    const identity = JSON.stringify(contract);
    const holder = `omb-coding-${createHash("sha256").update(requestId).digest("hex").slice(0, 24)}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR IGNORE INTO coding_workspaces (request_id, contract) VALUES (?, ?)").run(requestId, identity);
      const row = this.db.prepare("SELECT contract, path, lease_id, base_sha FROM coding_workspaces WHERE request_id = ?")
        .get(requestId) as { contract: string; path: string | null; lease_id: string | null; base_sha: string | null };
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
        !this.verifySlot(slot.path)) {
        throw new Error("Treehouse lease could not be verified");
      }
      if (row.path && row.path !== slot.path || row.lease_id && row.lease_id !== slot.lease_id) {
        throw new Error("workspace lease changed for the same request");
      }
      const currentHead = this.readRevision(slot.path, "HEAD");
      if (!row.base_sha && (this.readStatus(slot.path) || currentHead !== this.readRevision(slot.path, contract.ref))) {
        throw new Error("workspace base cannot be recovered after uncertain work");
      }
      const base = row.base_sha ?? currentHead;
      this.db.prepare("UPDATE coding_workspaces SET path = ?, lease_id = ?, base_sha = ? WHERE request_id = ?")
        .run(slot.path, slot.lease_id, base, requestId);
      this.db.exec("COMMIT");
      return { repository: contract.repository, directory: slot.path, branch: contract.ref,
        base, leaseId: slot.lease_id };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private gitCommonDir(path: string): string {
    const output = execFileSync(this.gitExecutable, ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: path, encoding: "utf8", timeout: 10_000 }).trim();
    return realpathSync(resolve(path, output));
  }
  async release(leaseId: string): Promise<void> {
    const slot = this.slots().find((candidate) => candidate.lease_id === leaseId && candidate.status === "leased");
    if (!slot || !slot.lease_holder?.startsWith("omb-coding-") || !this.verifySlot(slot.path)) {
      throw new Error("workspace lease cannot be verified for release");
    }
    const recorded = this.db.prepare("SELECT request_id, contract, base_sha FROM coding_workspaces WHERE path = ? AND lease_id = ?")
      .get(slot.path, leaseId) as { request_id: string; contract: string; base_sha: string | null } | undefined;
    if (!recorded?.base_sha || slot.lease_holder !== `omb-coding-${createHash("sha256").update(recorded.request_id).digest("hex").slice(0, 24)}`) {
      throw new Error("workspace lease does not belong to this request");
    }
    const git = (...args: string[]) => execFileSync(this.gitExecutable, args, { cwd: slot.path, encoding: "utf8", timeout: 30_000 }).trim();
    const currentBranch = git("rev-parse", "--abbrev-ref", "HEAD");
    const suffix = createHash("sha256").update(leaseId).digest("hex").slice(0, 12);
    const ref = (JSON.parse(recorded.contract) as RunContractInput).ref;
    const salvage = `openai-work/${ref.replace(/[^a-zA-Z0-9._-]/g, "-")}-${suffix}`;
    const dirty = Boolean(git("status", "--porcelain", "--untracked-files=all"));
    const pushed = ["@{upstream}", "origin/main"].some((ref) => {
      try { git("merge-base", "--is-ancestor", "HEAD", ref); return true; } catch { return false; }
    });
    let activeBranch = currentBranch;
    if (dirty || !pushed) {
      if (!currentBranch.startsWith("openai-work/")) {
        git("switch", "-c", salvage);
        activeBranch = salvage;
      }
      if (dirty) {
        git("add", "-A");
        git("-c", "user.name=evoclock", "-c", "user.email=52983349+evoclock@users.noreply.github.com",
          "commit", "-m", `Salvage coding workspace ${recorded.request_id}`);
      }
    }
    if (activeBranch.startsWith("openai-work/")) {
      const dir = this.salvageDir;
      const bundle = join(dir, `${activeBranch.slice("openai-work/".length)}.bundle`);
      mkdirSync(dir, { recursive: true });
      git("bundle", "create", bundle, activeBranch);
      git("bundle", "verify", bundle);
      appendFileSync(join(dir, "INDEX.md"), `- ${activeBranch} | ${bundle} | ${slot.path}\n`);
    }
    if (git("status", "--porcelain", "--untracked-files=all")) throw new Error("workspace changed during reconciliation");
    const ignored = execFileSync(this.gitExecutable, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
      { cwd: slot.path, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }).toString("utf8").split("\0").filter(Boolean);
    if (ignored.length > 10_000) throw new Error("Too many ignored files to salvage; lease retained");
    if (ignored.length) {
      const target = join(this.salvageDir, `ignored-${suffix}-${randomUUID()}`);
      let bytes = 0;
      for (const name of ignored) {
        if (name.startsWith("/") || name.split("/").includes("..")) throw new Error("Unsafe ignored path; lease retained");
        const source = join(slot.path, name);
        const stat = lstatSync(source);
        bytes += stat.size;
        if (bytes > 1024 * 1024 * 1024) throw new Error("Ignored files exceed salvage budget; lease retained");
        const output = join(target, name);
        mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
        if (stat.isSymbolicLink()) writeFileSync(`${output}.symlink.txt`, readlinkSync(source), { flag: "wx", mode: 0o600 });
        else if (stat.isFile()) copyFileSync(source, output);
        else throw new Error("Unsupported ignored file; lease retained");
      }
      appendFileSync(join(this.salvageDir, "INDEX.md"), `- ignored files | ${target} | ${slot.path}\n`);
    }
    this.call("return", slot.path, "--if-lease-id", leaseId, "--if-lease-holder", slot.lease_holder);
    this.db.prepare("DELETE FROM coding_workspaces WHERE path = ? AND lease_id = ?").run(slot.path, leaseId);
  }
}
