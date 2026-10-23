#!/usr/bin/env node
// Per-minute status reporter for the OpenMausBot session status feed.
// A launchd job runs this; it reads one JSON file per active session and posts
// each as a heartbeat. It never starts a coordinator turn: only a change does that.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const STATUS_DIR = process.env.OMB_SESSION_STATUS_DIR ?? join(homedir(), ".openmausbot", "session-status");
const OMB_URL = (process.env.OMB_URL ?? "http://127.0.0.1:8799").replace(/\/+$/, "");
const TOKEN = process.env.OMB_STATUS_TOKEN ?? "";
const STALE_MINUTES = Number(process.env.OMB_STATUS_STALE_MINUTES ?? 60);
const MAX_FILE_BYTES = 64 * 1024;
const SESSION_ID = /^[\w-]+$/;
const STATES = new Set(["queued", "running", "waiting", "blocked", "unverified", "done", "failed", "cancelled"]);

const now = Date.now();
// A stable id per minute: a second run in the same minute is a duplicate, not a new report.
const sequence = Math.floor(now / 60_000);

function warn(line) {
  process.stderr.write(`session-status: ${line}\n`);
}

function readSession(file) {
  const path = join(STATUS_DIR, file);
  const sessionId = file.slice(0, -".json".length);
  if (!SESSION_ID.test(sessionId)) return null;
  const stat = statSync(path);
  if (now - stat.mtimeMs > STALE_MINUTES * 60_000) return null;
  if (stat.size > MAX_FILE_BYTES) {
    warn(`${sessionId}: status file is larger than ${MAX_FILE_BYTES} bytes; skipped`);
    return null;
  }
  let body;
  try {
    body = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    warn(`${sessionId}: unreadable status file (${error instanceof Error ? error.message : String(error)}); skipped`);
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    warn(`${sessionId}: status file must hold one JSON object; skipped`);
    return null;
  }
  if (!STATES.has(body.state)) {
    warn(`${sessionId}: state must be one of ${[...STATES].join(", ")}; skipped`);
    return null;
  }
  const progressAt = Number(body.progressAt ?? stat.mtimeMs);
  if (!Number.isSafeInteger(progressAt) || progressAt <= 0) {
    warn(`${sessionId}: progressAt must be a positive whole millisecond timestamp; skipped`);
    return null;
  }
  return { ...body, sessionId, progressAt, reportedAt: now, sequence, reportId: `${sessionId}:${sequence}` };
}

async function post(report) {
  const response = await fetch(`${OMB_URL}/api/session-status/report`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    warn(`${report.sessionId}: OpenMausBot answered ${response.status}`);
    return false;
  }
  return true;
}

let files;
try {
  files = readdirSync(STATUS_DIR).filter((file) => file.endsWith(".json") && !file.startsWith("."));
} catch (error) {
  if (error && typeof error === "object" && error.code === "ENOENT") process.exit(0);
  warn(`cannot read ${STATUS_DIR}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(0);
}

let sent = 0;
for (const file of files) {
  let report;
  try {
    report = readSession(file);
  } catch (error) {
    warn(`${file}: ${error instanceof Error ? error.message : String(error)}; skipped`);
    continue;
  }
  if (!report) continue;
  try {
    if (await post(report)) sent += 1;
  } catch (error) {
    warn(`${report.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (sent > 0) warn(`posted ${sent} heartbeat${sent === 1 ? "" : "s"}`);
