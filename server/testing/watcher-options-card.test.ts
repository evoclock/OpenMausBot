import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { WATCHER_OPTIONS_CARD_BOT_ID } from "../../shared/options-card.ts";
import { createOptionsCard } from "../options-card.ts";
import {
  agentsCapabilityForBot,
  isolateWatcherBot,
  prepareWatcherOptionsCard,
  settleRestartWork,
  settleWebhooks,
} from "./watcher-options-card.ts";

const CREATED = "11111111-1111-4111-8111-111111111111";
const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CARD = { title: "Deploy now?", subtitle: "The build is green.", options: ["Yes", "No"] };

function dump(botId: string) {
  return {
    mcpConfig: {
      mcpServers: {
        agents: {
          command: "node",
          args: ["agents-proxy.js"],
          env: { OMB_HARNESS_URL: "http://127.0.0.1:9", OMB_BOT_ID: botId, OMB_COMMS_TOKEN: `token-${botId}` },
        },
      },
    },
  };
}

it("refuses an options card when the engine dump belongs to another bot", () => {
  expect(agentsCapabilityForBot(dump(OTHER), WATCHER_OPTIONS_CARD_BOT_ID)).toBeUndefined();
  expect(agentsCapabilityForBot({ mcpConfig: null }, WATCHER_OPTIONS_CARD_BOT_ID)).toBeUndefined();
  const refused = createOptionsCard({
    store: { appendMessage: () => ({ id: "should-not-exist" }) },
    bot: { id: OTHER, name: "Nightly", color: "blue" },
    threadId: "thread-other",
    input: CARD,
  });
  expect(refused).toEqual({ ok: false, status: 403, error: "create_options_card is not enabled for this bot." });

  const watcher = agentsCapabilityForBot(dump(WATCHER_OPTIONS_CARD_BOT_ID), WATCHER_OPTIONS_CARD_BOT_ID);
  expect(watcher?.env.OMB_BOT_ID).toBe(WATCHER_OPTIONS_CARD_BOT_ID);
  expect(createOptionsCard({
    store: { appendMessage: () => ({ id: "m1" }) },
    bot: { id: watcher!.env.OMB_BOT_ID, name: "Watcher", color: "blue" },
    threadId: "thread-1",
    input: CARD,
  })).toEqual({ ok: true, messageId: "m1" });
});

it("a restart keeps the Watcher bot only and does not leave live routine runs", () => {
  const isolated = isolateWatcherBot([
    { id: OTHER, name: "Nightly", threadId: "thread-other", cwd: `/tmp/${CREATED}/shared` },
    { id: CREATED, name: "Watcher", threadId: "thread-1", cwd: `/tmp/${CREATED}/work` },
  ], CREATED);
  expect(isolated.threadId).toBe("thread-1");
  expect(isolated.bots).toEqual([{
    id: WATCHER_OPTIONS_CARD_BOT_ID,
    name: "Watcher",
    threadId: "thread-1",
    cwd: `/tmp/${WATCHER_OPTIONS_CARD_BOT_ID}/work`,
  }]);

  const settled = settleRestartWork({
    version: 1,
    routines: [{ id: "r1", enabled: true, runOnStartup: true, nextRunAt: 1, botId: OTHER }],
    runs: [
      { id: "run-live", status: "running", botId: OTHER, attention: "working" },
      { id: "run-queued", status: "queued", botId: OTHER, retryAt: 5 },
      { id: "run-waiting", status: "waiting", botId: OTHER },
      { id: "run-done", status: "completed", botId: OTHER },
    ],
  }) as {
    routines: Array<{ enabled: boolean; runOnStartup: boolean; nextRunAt: number | null }>;
    runs: Array<{ status: string; attention?: string; retryAt?: number }>;
  };
  expect(settled.routines[0]).toEqual({ id: "r1", enabled: false, runOnStartup: false, nextRunAt: null, botId: OTHER });
  expect(settled.runs.map((run) => run.status)).toEqual(["failed", "failed", "failed", "completed"]);
  expect(settled.runs[0]).not.toHaveProperty("attention");
  expect(settled.runs[1]).not.toHaveProperty("retryAt");
  expect(settleWebhooks({
    version: 1,
    webhooks: [{ id: "hook", enabled: true }],
    deliveries: [{ id: "delivery" }],
  })).toEqual({ version: 1, webhooks: [{ id: "hook", enabled: false }], deliveries: [{ id: "delivery" }] });
});

it("writes that roster into the data dir a restarted home reads", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-watcher-card-"));
  try {
    writeFileSync(join(dataDir, "bots.json"), JSON.stringify([
      { id: OTHER, name: "Nightly", threadId: "thread-other" },
      { id: CREATED, name: "Watcher", threadId: "thread-1" },
    ]));
    writeFileSync(join(dataDir, "routines.json"), JSON.stringify({
      version: 1,
      routines: [{ id: "r1", enabled: true, botId: OTHER }],
      runs: [{ id: "run-live", status: "running", botId: OTHER }],
    }));
    writeFileSync(join(dataDir, "webhooks.json"), JSON.stringify({ version: 1, webhooks: [{ id: "hook", enabled: true }] }));
    expect(prepareWatcherOptionsCard(dataDir, CREATED)).toEqual({ threadId: "thread-1" });
    expect(JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"))).toEqual([
      { id: WATCHER_OPTIONS_CARD_BOT_ID, name: "Watcher", threadId: "thread-1" },
    ]);
    expect(JSON.parse(readFileSync(join(dataDir, "routines.json"), "utf8")).runs[0].status).toBe("failed");
    expect(JSON.parse(readFileSync(join(dataDir, "routines.json"), "utf8")).routines[0].enabled).toBe(false);
    expect(JSON.parse(readFileSync(join(dataDir, "webhooks.json"), "utf8")).webhooks[0].enabled).toBe(false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
