// Copy-this-computer receiving routes. Each needs a paired admin-scope session and refuses client-scope devices and this
// machine's loopback (no wall against the machine itself, which can already read the data folder). A workspace shared with
// other people never receives one. Nothing here logs a body, a password or a file name.
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { sharedSignIn, type SignInLists } from "./admin-activity.ts";
import {
  backupsBytes, beginUpload, chatsSyncedAt, CLOUD_MOVE_MAX_BYTES, CLOUD_MOVE_MAX_PART_BYTES, CLOUD_MOVE_PART_BYTES, completedUpload, discardNextPreviousCloud,
  discardUpload, enabledRoutineCount, forgetMoveRestore, freeVolumeBytes, isEmptyWorkspace, moveSpaceNeeded, noteChatsBrought, noteMoveRestore, prepareNextPreviousCloud,
  previousCloud, previousCloudArchiveBytes, removeMoveFiles, stagePreviousCloud, tidyCloudMoveStorage, totalVolumeBytes, uploadStatus, validUploadDeclaration,
  workspaceContents, workspaceMoveSize, writeUploadPart, type PreviousCloud,
} from "./cloud-move.ts";
import { mergeStagedChats, type ChatMergeResult, type ChatStore } from "./cloud-chat-merge.ts";
import { commitPendingWorkspaceRestore, createWorkspaceBackup, stagedWorkspaceData, stageWorkspaceBackup } from "./workspace-backup.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { WorkspaceLeftBehind } from "../shared/workspace-backup.ts";

export const CLOUD_MOVE_PREFIX = "/api/cloud-move";
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });
const HELD_CACHE_MS = 30_000;

type MoveSummary = { appVersion: string; files: number; bytes: number; bots: number; groups: number; threads: number; messages: number };
export type CloudMoveJob =
  | { kind: "preview" | "restore" | "undo" | "merge"; state: "running" }
  | { kind: "preview"; state: "done"; id: string; summary: MoveSummary }
  | { kind: "restore" | "undo"; state: "done"; id: string; previous?: Omit<PreviousCloud, "bytes"> | null }
  | { kind: "merge"; state: "done"; id: string; result: ChatMergeResult }
  | { kind: "preview" | "restore" | "undo" | "merge"; state: "failed"; error: string };

/** A hosted organisation workspace, or (off a Cloud home) a sign-in list letting someone else in; the owner's own address alone is not. */
export function workspaceShared(input: { hosted: boolean; cloudHome: boolean; signIn: SignInLists }): boolean {
  return input.hosted || (!input.cloudHome && sharedSignIn(input.signIn));
}

export function createCloudMoveRoutes(options: {
  dataDir: string;
  appVersion: string;
  /** This server's identity, so the app never copies a computer onto itself. */
  environmentId: string;
  sharedWorkspace: () => boolean;
  readBody: (req: IncomingMessage, limit?: number) => Promise<unknown>;
  exclusive: <T>(work: () => Promise<T>, keepLocked?: boolean) => Promise<T>;
  authorized: (req: IncomingMessage, auth: RequestAuth) => boolean;
  status: () => { busy: boolean; pendingRestore: boolean };
  restored: { id?: string; restored?: boolean; rolledBack?: boolean; safetyCopyPath?: string; leftBehind?: WorkspaceLeftBehind };
  restart: () => void;
  /** Where Bring newer chats adds what an upload has and this server lacks; without one, this server cannot. */
  store?: ChatStore;
  freeBytes?: (path: string) => number;
  volumeBytes?: (path: string) => number;
  restartDelayMs?: number;
  gateRetryMs?: number;
}) {
  const freeBytes = options.freeBytes ?? freeVolumeBytes;
  const volumeBytes = (path: string): number | null => { try { return (options.volumeBytes ?? totalVolumeBytes)(path); } catch { return null; } };
  try { tidyCloudMoveStorage(options.dataDir, options.restored); } catch (error) {
    console.warn(`workspace copy: could not tidy backup storage (${error instanceof Error ? error.message : "unknown"})`);
  }
  const identity = { appVersion: options.appVersion, environmentId: options.environmentId };
  // Staged here by a preview; restore accepts nothing else.
  const staged = new Set<string>();
  let job: CloudMoveJob | null = null;
  let writing = false, discardPreview = false;
  let held: { at: number; bytes: number } | null = null;
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const check = (req: IncomingMessage, auth: RequestAuth) => {
    if (!options.authorized(req, auth)) throw failure("Your session changed. Start the copy again.", 403);
  };
  const ready = () => {
    if (job?.state === "running" || writing) throw failure("Another copy step is running on this server. Wait for it to finish.", 409);
    const status = options.status();
    if (status.pendingRestore) throw failure("This server is restarting to finish a restore. Try again in a minute.", 409);
    if (status.busy) throw failure("This server is busy with a backup. Try again when it finishes.", 409);
  };
  const dropStaged = () => {
    for (const id of staged) removeMoveFiles(options.dataDir, id);
    staged.clear();
    if (job?.kind === "preview" && job.state === "done") job = null;
  };
  function start(kind: CloudMoveJob["kind"], work: () => Promise<CloudMoveJob>, after?: (result: CloudMoveJob) => void) {
    const current: CloudMoveJob = { kind, state: "running" };
    job = current;
    held = null;
    void work().then((result) => {
      if (job !== current) return;
      job = result;
      after?.(result);
    }, (error: unknown) => {
      if (job === current) job = { kind, state: "failed", error: error instanceof Error ? error.message : "The copy could not finish." };
    });
  }
  const quietly = async <T>(work: () => Promise<T>, keepLocked = true): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try { return await options.exclusive(work, keepLocked); } catch (error) {
        if (attempt >= 4 || (error as { status?: number }).status !== 409) throw error;
        await new Promise((resolve) => setTimeout(resolve, options.gateRetryMs ?? 2_000));
      }
    }
  };
  /** On any failure nothing is left behind: not the new backup, not the staged files. */
  async function replaceWith(id: string, req: IncomingMessage, auth: RequestAuth) {
    noteMoveRestore(options.dataDir, id);
    try {
      return await quietly(async () => {
        check(req, auth);
        const previous = await prepareNextPreviousCloud(options.dataDir, id, (password) =>
          createWorkspaceBackup(options.dataDir, { password, appVersion: options.appVersion }));
        return { committed: commitPendingWorkspaceRestore(options.dataDir, id), previous };
      });
    } catch (error) {
      discardNextPreviousCloud(options.dataDir);
      forgetMoveRestore(options.dataDir, id);
      removeMoveFiles(options.dataDir, id);
      throw error;
    } finally { staged.delete(id); }
  }
  const roomFor = (archive: number, already = 0) => {
    const needed = moveSpaceNeeded(archive, workspaceMoveSize(options.dataDir).bytes, true) - already;
    const free = freeBytes(options.dataDir);
    return free >= needed ? null : { error: "This server does not have enough free space for this.", freeBytes: free, neededBytes: needed };
  };
  // Answer first; startup then installs the restore before anything else loads.
  const restartSoon = () => { setTimeout(() => options.restart(), options.restartDelayMs ?? 1_500).unref?.(); };

  return async (req: IncomingMessage, res: ServerResponse, path: string, auth: RequestAuth): Promise<boolean> => {
    if (path !== CLOUD_MOVE_PREFIX && !path.startsWith(`${CLOUD_MOVE_PREFIX}/`)) return false;
    const method = req.method ?? "GET";
    try {
      if (!auth.scopes.includes("admin")) throw failure("Only the owner can copy a workspace.", 403);
      if (method === "GET" && path === `${CLOUD_MOVE_PREFIX}/estimate`) {
        json(res, 200, { ...workspaceContents(options.dataDir), ...workspaceMoveSize(options.dataDir), routines: enabledRoutineCount(options.dataDir), maxBytes: CLOUD_MOVE_MAX_BYTES, ...identity });
        return true;
      }
      if (auth.kind !== "session") throw failure("Copying a workspace needs the owner's signed-in app.", 403);
      if (options.sharedWorkspace()) {
        throw Object.assign(failure("This server is shared with other people, so it can't receive one computer's bots and chats. Copy to a server only you use.", 403), { code: "shared_workspace" });
      }
      check(req, auth);
      if (method === "GET" && path === CLOUD_MOVE_PREFIX) {
        const contents = workspaceContents(options.dataDir);
        if (!held || held.at + HELD_CACHE_MS < Date.now()) held = { at: Date.now(), bytes: backupsBytes(options.dataDir) };
        json(res, 200, {
          contents, empty: isEmptyWorkspace(contents), freeBytes: freeBytes(options.dataDir), volumeBytes: volumeBytes(options.dataDir), maxBytes: CLOUD_MOVE_MAX_BYTES,
          partBytes: CLOUD_MOVE_PART_BYTES, upload: uploadStatus(options.dataDir), previous: previousCloud(options.dataDir), job,
          heldBytes: held.bytes,
          // The app refuses a server older than itself, or its own, before exporting.
          ...identity,
          ...options.status(),
          lastRestoreId: options.restored.restored ? options.restored.id ?? null : null,
          leftBehind: options.restored.restored ? options.restored.leftBehind ?? null : null,
          rolledBackId: options.restored.rolledBack ? options.restored.id ?? null : null,
        });
        return true;
      }
      if (method === "POST" && path === `${CLOUD_MOVE_PREFIX}/upload`) {
        const declared = validUploadDeclaration(z.object({ sha256: z.unknown(), bytes: z.unknown(), files: z.unknown().optional() }).parse(await options.readBody(req, 4096)));
        ready();
        dropStaged();
        const refused = roomFor(declared.bytes, uploadStatus(options.dataDir)?.received ?? 0);
        if (refused) { json(res, 507, refused); return true; }
        check(req, auth);
        held = null;
        json(res, 200, { ...beginUpload(options.dataDir, declared), partBytes: CLOUD_MOVE_PART_BYTES });
        return true;
      }
      const part = /^\/api\/cloud-move\/upload\/([a-f0-9]{64})$/.exec(path);
      if (method === "PUT" && part) {
        const offset = Number(new URL(req.url ?? "/", "http://cloud-move.invalid").searchParams.get("offset"));
        const length = Number(req.headers["content-length"]);
        if (!Number.isSafeInteger(length) || length <= 0 || length > CLOUD_MOVE_MAX_PART_BYTES) throw failure("Send each part with its length, at most 64 MB.", 411);
        ready();
        writing = true;
        let received: number;
        try { received = await writeUploadPart(options.dataDir, part[1], offset, length, req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>); }
        finally { writing = false; }
        json(res, 200, { received });
        return true;
      }
      if (method === "POST" && path === `${CLOUD_MOVE_PREFIX}/preview`) {
        const body = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), password: z.string().min(12).max(1024) }).parse(await options.readBody(req, 8192));
        ready();
        discardPreview = false;
        start("preview", async () => {
          const file = await completedUpload(options.dataDir, body.sha256);
          let result;
          try {
            result = await stageWorkspaceBackup(options.dataDir, file, { password: body.password, currentAppVersion: options.appVersion });
          } finally { discardUpload(options.dataDir); }
          if (discardPreview) {
            removeMoveFiles(options.dataDir, result.id);
            throw failure("The copy was stopped; what it staged was removed.", 409);
          }
          try { check(req, auth); } catch (error) { removeMoveFiles(options.dataDir, result.id); throw error; }
          staged.add(result.id);
          const { summary } = result;
          return { kind: "preview", state: "done", id: result.id, summary: {
            appVersion: summary.appVersion, files: summary.files, bytes: summary.bytes, bots: summary.bots,
            groups: summary.groups, threads: summary.threads, messages: summary.messages,
          } };
        });
        json(res, 202, { job });
        return true;
      }
      if (method === "POST" && path === `${CLOUD_MOVE_PREFIX}/merge` && options.store) {
        const body = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), password: z.string().min(12).max(1024) }).parse(await options.readBody(req, 8192));
        ready();
        dropStaged();
        const store = options.store;
        start("merge", async () => {
          const file = await completedUpload(options.dataDir, body.sha256);
          let staged;
          try { staged = await stageWorkspaceBackup(options.dataDir, file, { password: body.password, currentAppVersion: options.appVersion }); }
          finally { discardUpload(options.dataDir); }
          try {
            // Applied while no bot is mid-turn here, so nothing writes a conversation while rows are added to it.
            const result = await quietly(async () => {
              check(req, auth);
              const merged = mergeStagedChats(store, options.dataDir, stagedWorkspaceData(options.dataDir, staged.id), chatsSyncedAt(options.dataDir));
              noteChatsBrought(options.dataDir, staged.summary.createdAt);
              return merged;
            }, false);
            return { kind: "merge", state: "done", id: staged.id, result };
          } finally { removeMoveFiles(options.dataDir, staged.id); }
        });
        json(res, 202, { job });
        return true;
      }
      if (method === "POST" && path === `${CLOUD_MOVE_PREFIX}/discard`) {
        await options.readBody(req, 4096);
        if (job?.state === "running" && job.kind !== "preview") {
          throw failure(job.kind === "merge" ? "This server is adding chats from this computer. Wait for it to finish." : "This server is already replacing its workspace.", 409);
        }
        if (job?.state === "running") discardPreview = true;
        dropStaged();
        held = null;
        json(res, 200, { ok: true });
        return true;
      }
      if (method === "POST" && path === `${CLOUD_MOVE_PREFIX}/restore`) {
        const body = z.object({ id: z.string().uuid() }).parse(await options.readBody(req, 4096));
        ready();
        if (!staged.has(body.id)) throw failure("This copy is no longer ready on this server. Start it again.", 404);
        start("restore", async () => {
          const { committed, previous } = await replaceWith(body.id, req, auth);
          return { kind: "restore", state: "done", id: committed.id, previous };
        }, restartSoon);
        json(res, 202, { job });
        return true;
      }
      if (method === "POST" && path === `${CLOUD_MOVE_PREFIX}/undo`) {
        await options.readBody(req, 4096);
        ready();
        if (!previousCloud(options.dataDir)) throw failure("There is nothing on this server to swap back to.", 404);
        const refused = roomFor(previousCloudArchiveBytes(options.dataDir));
        if (refused) { json(res, 507, refused); return true; }
        dropStaged();
        start("undo", async () => {
          const prepared = await stagePreviousCloud(options.dataDir, options.appVersion);
          const { committed, previous } = await replaceWith(prepared.id, req, auth);
          return { kind: "undo", state: "done", id: committed.id, previous };
        }, restartSoon);
        json(res, 202, { job });
        return true;
      }
      json(res, 404, { error: "Unknown copy operation." });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return true; }
      const status = error instanceof z.ZodError ? 400 : (error as { status?: number }).status ?? 400;
      const received = (error as { received?: unknown }).received, code = (error as { code?: unknown }).code;
      json(res, status, {
        error: error instanceof z.ZodError ? "Invalid copy request." : error instanceof Error ? error.message : "The copy failed.",
        ...(Number.isSafeInteger(received) ? { received } : {}),
        ...(code === "shared_workspace" ? { code } : {}),
      });
    }
    return true;
  };
}
