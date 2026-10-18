// Copies this computer's workspace backup to a server the person owns: no credential, sign-in or session travels,
// the bearer lives only in memory, and this computer's data is never changed. "cloud" names stay: live Clouds use the routes.
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CLOUD_HOME_NAME } from "./cloud-home.mjs";

const MAGIC = Buffer.from("OMB-WORKSPACE-1\n");
const MIN_BYTES = MAGIC.length + 16 + 12 + 16;
export const CLOUD_MOVE_MAX_BYTES = 10 * 1024 ** 3 + 256 * 1024 ** 2;
const PART_BYTES = 16 * 1024 ** 2;
const MAX_PART_BYTES = 64 * 1024 ** 2;
// A proxy (nginx allows 1 MB by default) answers 413 to a part: parts halve down to this.
const MIN_PART_BYTES = 512 * 1024;
const SPACE_MARGIN = 256 * 1024 ** 2;
const GB = 1024 ** 3;
/** Must match openmaus-cloud's VOLUME_EXTEND step. */
const DISK_STEP_GB = 10;
const REUSE_MS = 30 * 60_000;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/;
const LOCAL_ROUTES = /^\/api\/(?:workspace-backup\/(?:status|export|download\/[a-f\d-]{36})|cloud-move\/estimate)$/;
const RESUMABLE = new Set(["upload_failed", "cloud_unavailable", "network", "cloud_busy", "cancelled", "proxy_limit"]);
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export class CloudMoveError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = "CloudMoveError"; this.code = code; this.details = details; }
}
const fail = (code, message, details) => { throw new CloudMoveError(code, message, details); };
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const defaultSleep = (ms, signal) => new Promise((done, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); done(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal?.addEventListener("abort", abort, { once: true });
});

export function cloudPageSenderAllowed(event, { contents, homeOrigin, activeOrigin }) {
  if (!contents || !homeOrigin || activeOrigin !== homeOrigin) return false;
  if (event?.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame) return false;
  try { return new URL(event.senderFrame.url).origin === homeOrigin; } catch { return false; }
}

/** Main decides where a copy goes, never the page; anything but this computer's page or the active server's own page is null. */
export function moveSenderDestination(event, { contents, environments, localOrigin, cloudHomeOrigin = null, id }) {
  if (!contents || event?.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame) return null;
  let origin;
  try { origin = new URL(event.senderFrame.url).origin; } catch { return null; }
  const saved = Array.isArray(environments?.environments) ? environments.environments : [];
  const active = saved.find(entry => entry.id === environments.activeId) ?? null;
  const named = id !== undefined && id !== null;
  if (!active && localOrigin && origin === localOrigin) {
    if (!named) return { entry: null, remote: false };
    if (id === "cloud") {
      return { entry: { ...(saved.find(entry => cloudHomeOrigin && entry.origin === cloudHomeOrigin) ?? { id: "cloud", name: CLOUD_HOME_NAME, origin: cloudHomeOrigin }), cloud: true }, remote: false };
    }
    const entry = typeof id === "string" ? saved.find(candidate => candidate.id === id) : undefined;
    return entry ? { entry, remote: false } : null;
  }
  if (named || !active || origin !== active.origin) return null;
  return { entry: active, remote: true };
}

export function moveRefusal(status, body) {
  if (status === 403 && body?.code === "shared_workspace") return "shared_workspace";
  if (status === 404) return "outdated";
  if (status === 401 || status === 403) return "owner_needed";
  return "unreachable";
}

export function olderVersion(a, b) {
  const [left, right] = [a, b].map(version => typeof version === "string" ? VERSION.exec(version)?.slice(1).map(Number) : undefined);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i];
  return false;
}

export function moveBlocked({ kind, refusal = null, local = null, cloud = null, busyElsewhere = false }) {
  if (busyElsewhere) return "busy_elsewhere";
  if (refusal && !(kind === "cloud" && (refusal === "owner_needed" || refusal === "unreachable"))) return refusal;
  if (local?.environmentId && cloud?.environmentId && local.environmentId === cloud.environmentId) return "same_computer";
  if (olderVersion(cloud?.appVersion, local?.appVersion)) return "outdated";
  return null;
}

/** The window's cookie only mints the code and is never the copy's credential: signing that out would sign the window out. */
export async function mintOwnerCode(fetchImpl, origin, { label = "Copy from desktop", timeoutMs = 15_000 } = {}) {
  const ask = (route, init = {}) => fetchImpl(`${origin}${route}`, { ...init, credentials: "include", redirect: "error", cache: "no-store",
    headers: { accept: "application/json", origin, ...init.headers }, signal: AbortSignal.timeout(timeoutMs) });
  const ownerNeeded = () => fail("owner_needed", "This app isn't signed in to that server as its owner. Pair it again with an owner code, then copy.");
  let response;
  try { response = await ask("/api/auth/session"); } catch { fail("network", "The copy could not reach that server. Check your connection and try again."); }
  const session = await readJson(response).catch(() => null);
  if (!response.ok || session?.kind !== "session" || !Array.isArray(session.scopes) || !session.scopes.includes("admin")) ownerNeeded();
  if (session.hosted === true) fail("shared_workspace", "That server is shared with other people, so it can't receive this computer's bots and chats.");
  try {
    response = await ask("/api/auth/pairing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scopes: ["admin", "client"], label }) });
  } catch { fail("network", "The copy could not reach that server. Check your connection and try again."); }
  const minted = await readJson(response).catch(() => null);
  if (!response.ok || typeof minted?.code !== "string") {
    if (minted?.code === "managed_policy" && sentence(minted.error)) fail("cloud_refused", sentence(minted.error));
    ownerNeeded();
  }
  return { origin, code: minted.code, expiresAt: count(minted.expiresAt) ? minted.expiresAt : Date.now() + 60_000 };
}

export function parseMoveEstimate(value) {
  if (!record(value) || !["bots", "rooms", "chats", "bytes", "files"].every(key => count(value[key]))) return null;
  return { bots: value.bots, rooms: value.rooms, chats: value.chats, bytes: value.bytes, files: value.files, ...(count(value.routines) ? { routines: value.routines } : {}),
    ...identity(value) };
}
const identity = value => ({
  appVersion: typeof value.appVersion === "string" && VERSION.test(value.appVersion) ? value.appVersion : null,
  environmentId: typeof value.environmentId === "string" && /^[\w-]{1,128}$/.test(value.environmentId) ? value.environmentId : null,
});

/** Mirrors the Cloud's own room rule (three times the upload, plus a margin); the Cloud checks again before uploading. */
export function moveFit({ localBytes, freeBytes, uploadReceived = 0, volumeBytes = null, disk = null }) {
  const neededBytes = 3 * localBytes + SPACE_MARGIN, available = freeBytes + uploadReceived;
  const maxBytes = count(disk?.maxBytes) && disk.maxBytes > 0 ? disk.maxBytes : null;
  const volume = [volumeBytes, disk?.volumeBytes, disk?.startBytes].find(value => count(value) && value > 0) ?? null;
  if (available >= neededBytes) return { fit: "now", neededBytes, freeBytes: available };
  const room = maxBytes && volume && maxBytes > volume ? maxBytes - volume : 0;
  if (room > 0 && available + room >= neededBytes) {
    const sizeGb = Math.min(Math.floor(maxBytes / GB), Math.ceil((volume + neededBytes - available) / GB / DISK_STEP_GB) * DISK_STEP_GB);
    return { fit: "grow", neededBytes, freeBytes: available, maxBytes, sizeGb };
  }
  return { fit: "never", neededBytes, freeBytes: available, ...(maxBytes ? { maxBytes, ...(disk?.largest === true ? { largest: true } : {}) } : volume ? { volumeBytes: volume } : {}) };
}
function leftBehindOf(value) {
  if (!record(value) || !count(value.bots) || !Array.isArray(value.paths)) return null;
  const paths = value.paths.filter(path => typeof path === "string" && path.length <= 4096).slice(0, 20).map(sentence).filter(Boolean);
  return value.bots || paths.length ? { bots: value.bots, paths } : null;
}
const BROUGHT = ["conversations", "messages", "intoExisting", "skippedBots", "skippedRooms", "deleted"];
export function parseBrought(value) {
  return record(value) && BROUGHT.every(key => count(value[key])) ? Object.fromEntries(BROUGHT.map(key => [key, value[key]])) : null;
}
export function parseCloudMoveStatus(value) {
  if (!record(value) || !record(value.contents) || !["bots", "rooms", "chats"].every(key => count(value.contents[key])) ||
    typeof value.empty !== "boolean" || !count(value.freeBytes)) return null;
  const previous = record(value.previous) && typeof value.previous.createdAt === "string" && ["bots", "rooms", "chats"].every(key => count(value.previous[key]))
    ? { createdAt: value.previous.createdAt, bots: value.previous.bots, rooms: value.previous.rooms, chats: value.previous.chats, ...(count(value.previous.bytes) ? { bytes: value.previous.bytes } : {}) } : null;
  return {
    contents: { bots: value.contents.bots, rooms: value.contents.rooms, chats: value.contents.chats },
    empty: value.empty, freeBytes: value.freeBytes, previous,
    volumeBytes: count(value.volumeBytes) && value.volumeBytes > 0 ? value.volumeBytes : null,
    uploadReceived: record(value.upload) && count(value.upload.received) ? value.upload.received : 0,
    heldBytes: count(value.heldBytes) ? value.heldBytes : null,
    pendingRestore: value.pendingRestore === true, busy: value.busy === true,
    job: record(value.job) ? value.job : null,
    lastRestoreId: typeof value.lastRestoreId === "string" ? value.lastRestoreId : null,
    leftBehind: leftBehindOf(value.leftBehind),
    rolledBackId: typeof value.rolledBackId === "string" ? value.rolledBackId : null,
    partBytes: Number.isSafeInteger(value.partBytes) && value.partBytes > 0 && value.partBytes <= MAX_PART_BYTES ? value.partBytes : PART_BYTES,
    ...identity(value),
  };
}

async function readJson(response, limit = 256 * 1024) {
  const chunks = []; let size = 0;
  if (response.body) {
    for await (const chunk of Readable.fromWeb(response.body)) {
      size += chunk.length;
      if (size > limit) fail("invalid_response", "An unexpectedly large answer was refused.");
      chunks.push(chunk);
    }
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"); } catch { return null; }
}
async function discard(response) { try { await response?.body?.cancel(); } catch {} }
const sentence = value => typeof value === "string" && value.trim()
  // oxlint-disable-next-line no-control-regex
  ? value.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 300) : undefined;

export function createCloudMove({ localRequest, fetchImpl = fetch, tempRoot, availableBytes, now = Date.now, sleep = defaultSleep,
  onState = () => {}, retryDelaysMs = [1_000, 3_000, 8_000, 15_000, 30_000], pollMs = 2_000, restartTimeoutMs = 10 * 60_000, jobTimeoutMs = 3 * 3600_000,
  growTimeoutMs = 5 * 60_000 }) {
  if (typeof localRequest !== "function" || typeof tempRoot !== "string" || !isAbsolute(tempRoot) ||
    resolve(tempRoot) === parse(resolve(tempRoot)).root || typeof availableBytes !== "function") throw new Error("A copy needs its requests and a private temporary folder.");
  let value = { phase: "idle" }, running = false, controller = null, committing = false, prepared = null;
  let target = null, action = "move";
  const state = () => structuredClone(value);
  const publish = next => { value = target ? { ...next, destination: target } : next; try { onState(state()); } catch {} return state(); };
  const there = () => target?.kind === "cloud" ? "My Cloud" : target?.name || "the server";
  const There = () => target?.kind === "cloud" ? "My Cloud" : target?.name || "The server";
  let progressAt = 0;
  const progress = (phase, bytesTransferred, totalBytes) => {
    if (value.phase === phase && bytesTransferred < totalBytes && now() - progressAt < 250) return;
    progressAt = now();
    publish({ phase, action, progress: { bytesTransferred, totalBytes } });
  };

  async function localJson(route, init, signal) {
    if (!LOCAL_ROUTES.test(route)) fail("invalid_request", "Unsupported local request.");
    const response = await localRequest(route, { ...init, signal, redirect: "error" });
    if (!response.ok) {
      const said = sentence((await readJson(response).catch(() => null))?.error);
      if ([409, 503].includes(response.status)) fail("busy", said ?? "Wait for bots on this computer to finish what they are doing, then copy again.");
      fail("export_failed", said ?? "This computer's workspace could not be prepared for the copy.");
    }
    const body = await readJson(response, 2 * 1024 ** 2);
    if (!record(body)) fail("export_failed", "This computer's workspace could not be prepared for the copy.");
    return body;
  }
  async function estimate(signal) {
    const result = parseMoveEstimate(await localJson("/api/cloud-move/estimate", { method: "GET" }, signal ?? AbortSignal.timeout(60_000)));
    if (!result) fail("export_failed", "This computer's workspace could not be measured.");
    return result;
  }

  async function openSession(dest, signal) {
    let grant;
    try { grant = await dest.grant(); } catch (error) {
      if (error instanceof CloudMoveError) throw error;
      fail("cloud_unavailable", `${There()} is not ready for the copy. Check it, then try again.`);
    }
    // Only the destination itself may be signed in to: never an origin a grant names instead.
    if (!record(grant) || typeof grant.origin !== "string" || grant.origin !== dest.origin || typeof grant.code !== "string") fail("cloud_unavailable", `${There()} is not ready for the copy. Check it, then try again.`);
    const response = await fetchImpl(`${dest.origin}/api/auth/pair`, {
      method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ code: grant.code, label: "Copy from desktop" }), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    const body = await readJson(response);
    if (!response.ok || typeof body?.token !== "string" || !body.token.startsWith("omb_sess_")) fail("cloud_unavailable", `This app could not sign in to ${there()} for the copy. Try again.`);
    return { origin: dest.origin, token: body.token };
  }
  async function closeSession(session) {
    try { await discard(await cloudFetch(session, "/api/auth/logout", { method: "POST", signal: AbortSignal.timeout(10_000) })); } catch {}
  }
  function cloudFetch(session, route, { headers, ...init } = {}) {
    return fetchImpl(`${session.origin}${route}`, { ...init, redirect: "error", credentials: "omit", cache: "no-store",
      headers: { accept: "application/json", authorization: `Bearer ${session.token}`, ...headers } });
  }
  function cloudRefusal(status, body) {
    const message = typeof body?.error === "string" ? body.error.slice(0, 300) : undefined;
    if (status === 403 && body?.code === "shared_workspace") fail("shared_workspace", message ?? `${There()} is shared with other people, so it can't receive this computer's bots and chats.`);
    if (status === 401 || status === 403) fail("access_changed", `This app's sign-in to ${there()} changed. Open it in this app again, then copy.`);
    if (status === 507) fail("cloud_full", `${There()} does not have enough free space for this copy.`, { freeBytes: count(body?.freeBytes) ? body.freeBytes : undefined, neededBytes: count(body?.neededBytes) ? body.neededBytes : undefined });
    if (status === 413) fail("too_large", "This workspace is larger than a copy can carry.");
    if (status === 409) fail("cloud_busy", message ?? `${There()} is busy. Try again in a minute.`);
    if (status === 404) fail("not_found", message ?? `${There()} does not know this copy. Start it again.`);
    if (status >= 500 || status === 429 || status === 408) fail("network", `${There()} did not answer. Try again; the copy continues where it stopped.`);
    fail("cloud_refused", message ?? `${There()} refused the copy.`);
  }
  async function cloudJson(session, method, route, body, signal) {
    const response = await cloudFetch(session, route, { method, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const result = await readJson(response);
    if (!response.ok) cloudRefusal(response.status, result);
    if (!record(result)) fail("invalid_response", `${There()} gave an answer this app does not understand.`);
    return result;
  }
  async function cloudStatus(session, signal) {
    const answer = await cloudJson(session, "GET", "/api/cloud-move", undefined, signal).catch(error => {
      if (error?.code === "not_found") fail("outdated", `${There()} has not updated to a version that can receive a copy yet.`);
      throw error;
    });
    const status = parseCloudMoveStatus(answer);
    if (!status) fail("invalid_response", `${There()} gave an answer this app does not understand. Update the app and try again.`);
    return status;
  }

  async function disposeArchive() {
    const previous = prepared; prepared = null;
    if (previous) await rm(previous.directory, { recursive: true, force: true }).catch(() => {});
  }
  async function archive(local, signal) {
    if (prepared && now() - prepared.createdAt < REUSE_MS && await lstat(prepared.file).then(stat => stat.isFile() && stat.size === prepared.bytes, () => false)) return prepared;
    await disposeArchive();
    publish({ phase: "exporting", action });
    const status = await localJson("/api/workspace-backup/status", { method: "GET" }, signal);
    if (status.busy || status.pendingRestore) fail("busy", "Wait for this computer's backup or restore to finish, then copy again.");
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    const root = await lstat(tempRoot);
    if (!root.isDirectory() || root.isSymbolicLink() || (process.platform !== "win32" && (root.mode & 0o077) !== 0)) fail("local_failed", "The copy needs a private temporary folder.");
    const directory = await mkdtemp(join(tempRoot, "cloud-move-"));
    try {
      await chmod(directory, 0o700);
      if (await availableBytes(directory) < local.bytes + SPACE_MARGIN) fail("local_full", "This computer does not have enough free disk space to prepare the copy.");
      const password = randomBytes(32).toString("base64url");
      const exported = await localJson("/api/workspace-backup/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password, clientState: {} }) }, signal);
      if (typeof exported.id !== "string" || !UUID.test(exported.id) || !Number.isSafeInteger(exported.bytes) || exported.bytes < MIN_BYTES || !record(exported.summary)) fail("export_failed", "This computer's workspace could not be prepared for the copy.");
      if (exported.bytes > CLOUD_MOVE_MAX_BYTES) fail("too_large", "This workspace is larger than a copy can carry.");
      const response = await localRequest(`/api/workspace-backup/download/${exported.id}`, { method: "GET", signal, redirect: "error" });
      const declared = response.headers.get("content-length");
      if (!response.ok || !response.body || (declared !== null && Number(declared) !== exported.bytes)) { await discard(response); fail("export_failed", "This computer's workspace could not be prepared for the copy."); }
      const file = join(directory, "workspace.ombbackup"), hash = createHash("sha256"), header = Buffer.alloc(MAGIC.length);
      let bytes = 0;
      await pipeline(Readable.fromWeb(response.body), async function* (source) {
        for await (const chunk of source) {
          if (bytes + chunk.length > exported.bytes) fail("export_failed", "This computer's workspace changed size while it was prepared.");
          if (bytes < header.length) chunk.copy(header, bytes, 0, Math.min(chunk.length, header.length - bytes));
          bytes += chunk.length; hash.update(chunk);
          progress("exporting", bytes, exported.bytes);
          yield chunk;
        }
      }, createWriteStream(file, { flags: "wx", mode: 0o600 }), { signal });
      if (bytes !== exported.bytes || !header.equals(MAGIC)) fail("export_failed", "This computer's workspace could not be prepared for the copy.");
      const summary = exported.summary;
      prepared = { directory, file, password, sha256: hash.digest("hex"), bytes, createdAt: now(),
        summary: { bots: count(summary.bots) ? summary.bots : 0, files: count(summary.files) ? summary.files : 0, messages: count(summary.messages) ? summary.messages : 0 } };
      return prepared;
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  /** null when a proxy refused the part as too large: the server itself refuses oversized parts with 411, never 413. */
  async function sendPart(session, sha256, offset, part, signal) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let answer;
      try {
        const response = await cloudFetch(session, `/api/cloud-move/upload/${sha256}?offset=${offset}`, {
          method: "PUT", headers: { "content-type": "application/octet-stream" }, body: part,
          signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
        });
        answer = { status: response.status, body: await readJson(response) };
      } catch (error) {
        if (signal.aborted || error instanceof CloudMoveError) throw error;
        answer = null;
      }
      if (answer?.status === 200 && count(answer.body?.received)) return answer.body.received;
      if (answer?.status === 409 && count(answer.body?.received) && answer.body.received !== offset) return answer.body.received;
      if (answer?.status === 413) return null;
      if (answer && ![409, 408, 429, 500, 502, 503, 504].includes(answer.status)) cloudRefusal(answer.status, answer.body);
      if (attempt >= retryDelaysMs.length) fail("upload_failed", `The upload to ${there()} kept failing. Check your connection and try again; it continues where it stopped.`);
      await sleep(retryDelaysMs[attempt], signal);
    }
  }
  async function upload(session, archived, signal) {
    const begun = await cloudJson(session, "POST", "/api/cloud-move/upload", { sha256: archived.sha256, bytes: archived.bytes, files: archived.summary.files }, signal);
    if (!count(begun.received) || begun.received > archived.bytes) fail("invalid_response", `${There()} gave an answer this app does not understand.`);
    let partBytes = Number.isSafeInteger(begun.partBytes) && begun.partBytes > 0 && begun.partBytes <= MAX_PART_BYTES ? begun.partBytes : PART_BYTES;
    let offset = begun.received, stalls = 0;
    progress("uploading", offset, archived.bytes);
    const handle = await open(archived.file, "r");
    try {
      while (offset < archived.bytes) {
        const part = Buffer.alloc(Math.min(partBytes, archived.bytes - offset));
        let filled = 0;
        while (filled < part.length) {
          const { bytesRead } = await handle.read(part, filled, part.length - filled, offset + filled);
          if (!bytesRead) fail("export_failed", "The prepared workspace changed on this computer.");
          filled += bytesRead;
        }
        const received = await sendPart(session, archived.sha256, offset, part, signal);
        if (received === null) {
          if (part.length > MIN_PART_BYTES) { partBytes = Math.max(MIN_PART_BYTES, Math.floor(part.length / 2)); continue; }
          fail("proxy_limit", `A proxy in front of ${there()} refused a ${Math.round(part.length / 1024)} KB upload. Raise its request size limit (nginx: client_max_body_size 64m), then copy again.`,
            { partBytes: part.length });
        }
        if (received > archived.bytes) fail("invalid_response", `${There()} gave an answer this app does not understand.`);
        stalls = received > offset ? 0 : stalls + 1;
        if (stalls > retryDelaysMs.length) fail("upload_failed", `The upload to ${there()} kept failing. Check your connection and try again; it continues where it stopped.`);
        offset = received;
        progress("uploading", offset, archived.bytes);
      }
    } finally { await handle.close(); }
  }

  async function waitForPreview(session, signal) {
    const deadline = now() + jobTimeoutMs;
    for (;;) {
      await sleep(pollMs, signal);
      let status = null;
      try { status = await cloudStatus(session, signal); } catch (error) { if (signal.aborted || error?.code === "access_changed") throw error; }
      const job = status?.job;
      if (job?.kind === "preview" && job.state === "failed") fail("invalid_backup", typeof job.error === "string" ? job.error.slice(0, 300) : `${There()} could not read the copied workspace.`);
      if (job?.kind === "preview" && job.state === "done" && typeof job.id === "string" && UUID.test(job.id) && record(job.summary)) return job;
      if (status && job?.kind !== "preview") fail("network", `${There()} restarted during the copy. Try again.`);
      if (now() > deadline) fail("cloud_busy", `${There()} is taking too long to check the copied workspace.`);
    }
  }
  async function waitForRestart(session, kind, target, signal) {
    let deadline = now() + jobTimeoutMs, restarting = false;
    const restartBegins = () => { if (!restarting) { restarting = true; deadline = Math.min(deadline, now() + restartTimeoutMs); publish({ ...value, phase: "restarting" }); } };
    let id = target.id, sawJob = false;
    for (;;) {
      await sleep(pollMs, signal);
      let status = null;
      try { status = await cloudStatus(session, signal); } catch (error) { if (signal.aborted || error?.code === "access_changed") throw error; }
      if (status) {
        const job = status.job;
        if (job?.kind === kind) sawJob = true;
        if (job?.kind === kind && job.state === "failed") fail("restore_failed", typeof job.error === "string" ? job.error.slice(0, 300) : `${There()} could not restore the workspace.`);
        if (job?.kind === kind && job.state === "done" && typeof job.id === "string") { id = job.id; restartBegins(); }
        const restored = id ? status.lastRestoreId === id : status.lastRestoreId !== null && status.lastRestoreId !== target.lastRestoreId;
        const rolledBack = id ? status.rolledBackId === id : status.rolledBackId !== null && status.rolledBackId !== target.rolledBackId;
        if (rolledBack) fail("restore_failed", `${There()} could not install the workspace and kept what it had.`);
        if (restored && !status.pendingRestore && status.job?.state !== "running") return status;
        if (!restored && !status.pendingRestore && job?.kind !== kind) {
          fail(sawJob ? "restore_failed" : "network", sawJob ? `${There()} restarted without installing the workspace. Try again.` : `${There()} did not start replacing its workspace. Try again.`);
        }
      } else restartBegins();
      if (now() > deadline) {
        fail("restart_timeout", target?.kind === "cloud" ? "My Cloud is taking longer than usual to restart. Check it again in a few minutes."
          : `${There()} hasn't come back yet. If it doesn't start again on its own, start OpenMausBot there; it finishes installing the copy when it starts.`);
      }
    }
  }

  async function makeRoom(dest, session, fit, signal) {
    publish({ phase: "growing", action });
    const details = { freeBytes: fit.freeBytes, neededBytes: fit.neededBytes, maxBytes: fit.maxBytes };
    let answer = null;
    try { answer = await dest.grow(fit.sizeGb); } catch { signal.throwIfAborted(); fail("cloud_grow_unavailable", "My Cloud could not make room for this move just now.", details); }
    signal.throwIfAborted();
    if (!answer?.supported) fail("cloud_grow_unsupported", "My Cloud can't make room for a move this size yet.", details);
    if (answer.refused) fail("cloud_full", "My Cloud does not have enough space for this move.", details);
    const deadline = now() + growTimeoutMs;
    for (;;) {
      await sleep(pollMs, signal);
      let status = null;
      try { status = await cloudStatus(session, signal); } catch (error) { if (signal.aborted || error?.code === "access_changed") throw error; }
      if (status && status.freeBytes + status.uploadReceived >= fit.neededBytes) return;
      if (now() > deadline) fail("cloud_grow_unavailable", "My Cloud could not make room for this move in time.", details);
    }
  }

  async function waitForMerge(session, signal) {
    const deadline = now() + jobTimeoutMs;
    for (;;) {
      await sleep(pollMs, signal);
      let status = null;
      try { status = await cloudStatus(session, signal); } catch (error) { if (signal.aborted || error?.code === "access_changed") throw error; }
      const job = status?.job;
      if (job?.kind === "merge" && job.state === "failed") fail("merge_failed", typeof job.error === "string" ? job.error.slice(0, 300) : `${There()} could not add the chats.`);
      if (job?.kind === "merge" && job.state === "done") return parseBrought(job.result) ?? fail("invalid_response", `${There()} gave an answer this app does not understand.`);
      if (status && job?.kind !== "merge") fail("network", `${There()} restarted while adding the chats. Bring them again: nothing is added twice.`);
      if (now() > deadline) fail("cloud_busy", `${There()} is taking too long to add the chats.`);
    }
  }

  /** Everything a copy and a bring share up to the uploaded archive. */
  async function uploadArchive(dest, session, signal, requireEmpty) {
    const [cloud, local] = await Promise.all([cloudStatus(session, signal), estimate(signal)]);
    const why = moveBlocked({ kind: dest.kind, local, cloud });
    if (why) {
      fail(why, why === "outdated" ? `${There()} runs ${cloud.appVersion}; this computer runs ${local.appVersion}. Update it, then copy again.` : `${There()} can't receive this copy.`,
        { destVersion: cloud.appVersion, localVersion: local.appVersion });
    }
    if (requireEmpty && !cloud.empty) fail("not_empty", `${There()} already has bots or chats of its own, so nothing was copied.`);
    if (cloud.pendingRestore || cloud.busy || cloud.job?.state === "running") fail("cloud_busy", `${There()} is busy. Try again in a minute.`);
    if (local.bytes > CLOUD_MOVE_MAX_BYTES) fail("too_large", "This workspace is larger than a copy can carry.");
    let disk = null;
    if (dest.kind === "cloud" && typeof dest.disk === "function") { try { disk = dest.disk(); } catch {} }
    const fit = moveFit({ localBytes: local.bytes, freeBytes: cloud.freeBytes, uploadReceived: cloud.uploadReceived, volumeBytes: cloud.volumeBytes, disk });
    if (fit.fit === "never") {
      const details = { ...fit }; delete details.fit;
      fail("cloud_full", `${There()} does not have enough free space for this copy.`, details);
    }
    if (fit.fit === "grow" && typeof dest.grow === "function") await makeRoom(dest, session, fit, signal);
    const archived = await archive(local, signal);
    await upload(session, archived, signal);
    return { cloud, local, archived };
  }

  function classify(error, signal) {
    return error instanceof CloudMoveError && !(signal?.aborted && error.code !== "cancelled") ? error
      : signal?.aborted ? new CloudMoveError("cancelled", `The copy was stopped. ${There()} was not replaced.`)
        : error?.code === "ENOSPC" ? new CloudMoveError("local_full", "This computer does not have enough free disk space to prepare the copy.")
          : new CloudMoveError("network", `The copy could not reach ${there()}. Check your connection and try again.`);
  }
  function destinationOf(dest) {
    if (!record(dest) || (dest.kind !== "cloud" && dest.kind !== "server") || typeof dest.grant !== "function" || (dest.origin !== null && typeof dest.origin !== "string")) {
      throw new Error("A copy needs a destination.");
    }
    return { id: typeof dest.id === "string" ? dest.id : null, name: typeof dest.name === "string" ? dest.name : "", origin: dest.origin, kind: dest.kind };
  }
  async function run(kind, dest, work) {
    if (running) return state();
    const named = destinationOf(dest);
    if (prepared && target && target.origin !== named.origin) await disposeArchive();
    running = true; committing = false; controller = new AbortController(); target = named; action = kind;
    const signal = controller.signal;
    let session = null;
    try {
      publish({ phase: "preparing", action: kind });
      session = await openSession(dest, signal);
      return await work(session, signal);
    } catch (error) {
      const failure = classify(error, signal);
      if (session && !committing) {
        try { await discard(await cloudFetch(session, "/api/cloud-move/discard", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000) })); } catch {}
      }
      if (!RESUMABLE.has(failure.code) || committing) await disposeArchive();
      return publish({ phase: "failed", action: kind, error: { code: failure.code, message: failure.message, ...failure.details },
        ...(prepared ? { resumable: true } : {}) });
    } finally {
      running = false; controller = null;
      if (session) await closeSession(session);
    }
  }

  return {
    state,
    estimate,
    move: (dest, { requireEmpty = false } = {}) => run("move", dest, async (session, signal) => {
      const { cloud, local, archived } = await uploadArchive(dest, session, signal, requireEmpty);
      publish({ phase: "checking", action: "move" });
      await cloudJson(session, "POST", "/api/cloud-move/preview", { sha256: archived.sha256, password: archived.password }, signal);
      const preview = await waitForPreview(session, signal);
      if (preview.summary.bots !== archived.summary.bots || preview.summary.messages !== archived.summary.messages) fail("invalid_backup", `${There()} read a different workspace than this computer sent.`);
      publish({ phase: "replacing", action: "move", replacing: !cloud.empty });
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        committing = true;
        try { await cloudJson(session, "POST", "/api/cloud-move/restore", { id: preview.id }, signal); break; } catch (error) {
          if (error?.code === "network" || error instanceof TypeError || error?.name === "TimeoutError") break;
          committing = false;
          if (error?.code !== "cloud_busy" || attempt >= retryDelaysMs.length) throw error;
          await sleep(retryDelaysMs[attempt], signal);
        }
      }
      await disposeArchive();
      const after = await waitForRestart(session, "restore", { id: preview.id }, signal);
      return publish({ phase: "done", action: "move", moved: after.contents, previous: Boolean(after.previous), ...(local.routines > 0 ? { routines: local.routines } : {}),
        ...(after.leftBehind ? { leftBehind: after.leftBehind } : {}) });
    }),
    /** Adds to the destination only the conversations and messages it lacks; it never restarts or replaces anything there. */
    bring: dest => run("bring", dest, async (session, signal) => {
      const { archived } = await uploadArchive(dest, session, signal, false);
      publish({ phase: "merging", action: "bring" });
      committing = true;
      await cloudJson(session, "POST", "/api/cloud-move/merge", { sha256: archived.sha256, password: archived.password }, signal);
      await disposeArchive();
      return publish({ phase: "done", action: "bring", brought: await waitForMerge(session, signal) });
    }),
    restorePrevious: dest => run("restore", dest, async (session, signal) => {
      const before = await cloudStatus(session, signal);
      if (!before.previous) fail("no_previous", `There is nothing on ${there()} to swap back to.`);
      if (before.pendingRestore || before.busy || before.job?.state === "running") fail("cloud_busy", `${There()} is busy. Try again in a minute.`);
      committing = true;
      publish({ phase: "replacing", action: "restore" });
      await cloudJson(session, "POST", "/api/cloud-move/undo", {}, signal);
      const after = await waitForRestart(session, "undo", { lastRestoreId: before.lastRestoreId, rolledBackId: before.rolledBackId }, signal);
      return publish({ phase: "done", action: "restore", moved: after.contents });
    }),
    cancel() { if (running && !committing) controller?.abort(); return state(); },
    reset() { if (!running) { target = null; publish({ phase: "idle" }); } return state(); },
    running: () => running,
    async close() { controller?.abort(); await disposeArchive(); },
  };
}
