// An in-memory My Cloud with createSyncClient's surface, for the Files engine and service tests.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const GB = 1024 ** 3;

export function fakeCloud({ freeBytes = 100 * GB } = {}) {
  const folders = new Map();
  const calls = [];
  const missing = new Set();
  let ids = 0;
  let bots = { bots: [], groups: [] };
  const state = { freeBytes };
  const files = (id) => folders.get(id).files;
  const info = (path, bytes) => ({ path, size: bytes.length, mtimeMs: 1, sha256: sha(bytes) });
  const client = {
    summary: async () => ({ folders: [...folders.values()].map((entry) => entry.folder), cursor: 1, disk: { totalBytes: 10 * GB, freeBytes: state.freeBytes, syncedBytes: 0, botFileBytes: 0, trashBytes: 0, reserveBytes: GB } }),
    register: async (input) => {
      calls.push(["register", input.pcPath]);
      const existing = [...folders.values()].find((entry) => entry.folder.pcPath === input.pcPath && entry.folder.computerId === input.computerId);
      if (existing) return existing.folder;
      const folder = { id: `pc-${++ids}`, kind: "pc", computerId: input.computerId, computerName: input.computerName, pcPath: input.pcPath, cloudPath: `/data/Synced/PC/${input.name}` };
      folders.set(folder.id, { folder, files: new Map() });
      return folder;
    },
    unregister: async (id, keep) => { calls.push(["unregister", id, keep]); folders.delete(id); },
    files: async (id) => {
      if (missing.has(id)) throw Object.assign(new Error("missing"), { status: 410 });
      return [...files(id)].map(([path, bytes]) => info(path, bytes));
    },
    upload: async ({ folderId, path, file, size, sha256, baseSha256 }) => {
      calls.push(["upload", path]);
      if (state.freeBytes - size < GB) return { full: true, neededBytes: size + GB, freeBytes: state.freeBytes };
      const current = files(folderId).get(path);
      if ((current ? sha(current) : null) !== baseSha256) return { conflict: true, current: current ? info(path, current) : null };
      const bytes = readFileSync(file);
      if (sha(bytes) !== sha256) throw new Error("hash mismatch");
      files(folderId).set(path, bytes);
      state.freeBytes -= size;
      return { ok: true };
    },
    download: async (folderId, path, temporary) => {
      calls.push(["download", path]);
      const bytes = files(folderId).get(path);
      writeFileSync(temporary, bytes);
      return { sha256: sha(bytes) };
    },
    ops: async (folderId, ops) => ops.map((op) => {
      const list = files(folderId);
      if (op.op === "delete") {
        calls.push(["delete", op.path]);
        const current = list.get(op.path);
        if (current && sha(current) !== op.baseSha256) return { conflict: true, current: info(op.path, current) };
        list.delete(op.path);
        return { ok: true };
      }
      throw new Error(`unknown op ${op.op}`);
    }),
    // Like the real long poll, answers only when told to stop: a loop over it must not spin.
    changes: (_cursor, _waitMs, signal) => new Promise((resolve) => {
      if (signal?.aborted) return resolve({ cursor: 1, folderIds: [] });
      signal?.addEventListener("abort", () => resolve({ cursor: 1, folderIds: [] }), { once: true });
    }),
    trash: async () => [],
    restore: async () => ({}),
    bots: async () => bots,
  };
  return {
    client, folders, missing, calls, state,
    addFolder(folder) { folders.set(folder.id, { folder, files: new Map() }); return folder; },
    put(folderId, path, text) { files(folderId).set(path, Buffer.from(text)); },
    get(folderId, path) { return files(folderId).get(path)?.toString(); },
    setBots(value) { bots = value; },
  };
}
