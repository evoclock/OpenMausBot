import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

// Triggers v2, end to end on a real server with the scripted engine: a bot at Ask sets up a schedule and a webhook from
// chat with no card to confirm; the webhook's secret never reaches the transcript; the person's link works through the
// real receiver; runs show on the one live card; Undo removes what the bot made.
it("sets up schedule and webhook triggers from chat at Ask, with no confirmation, no leaked secret, and a working link", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const turns = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    if (method !== "GET") evidence.push({ method, path, status: response.status, result: value });
    return value;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    const { bot } = await cli("new-bot", "--name", "Trigger fixture");
    // At Ask: before Triggers v2 a bot's own routine applied here but a teammate's or a 21st waited on a card.
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
    const threadId = bot.activeTaskId as string;
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
    const turn = async (text: string, steps: unknown[], reply = "Done.") => {
      const before = turns().length;
      writeFileSync(planPath, JSON.stringify({ [bot.id]: { steps, reply } }));
      await cli("send", "--bot", bot.id, "--task", threadId, "--text", text);
      await expect.poll(() => turns().length, { timeout: 20_000 }).toBe(before + 1);
      await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "20");
      const latest = turns().at(-1);
      evidence.push({ turn: latest });
      return latest.evidence as Array<{ step?: { tool: string }; response: any }>;
    };
    const toolText = (entries: Array<{ step?: { tool: string }; response: any }>, tool: string) =>
      entries.find((entry) => entry.step?.tool === tool)!.response.result.content[0].text as string;
    const unanswered = async () => (await messages()).filter((message) => message.card && !message.card.answered && !message.card.dismissed && !message.card.expired);

    // 1. "Every weekday at 9" becomes a schedule trigger at once.
    const scheduled = await turn("Every weekday at 9, send me a summary of my inbox.", [
      { tool: "create_trigger", arguments: { when: "schedule", name: "Morning summary", instructions: "Summarize the fixture inbox; no external services.", schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"] } } },
    ]);
    expect(toolText(scheduled, "create_trigger")).toContain("applied at once");
    expect(await unanswered()).toEqual([]);
    const scheduleCard = (await messages()).findLast((message) => message.card?.routineRequest)!.card;
    expect(scheduleCard).toMatchObject({ autoApplied: true, answered: "allow", options: [] });
    const routineId = scheduleCard.routineRequest.resultId as string;
    expect((await api("GET", "/api/routines")).routines.find((routine: any) => routine.id === routineId)).toMatchObject({ botId: bot.id, enabled: true, sourceThreadId: threadId });

    // 2. "When our form tool calls" becomes a webhook trigger; the bot never sees its secret.
    const hooked = await turn("Whenever our sales form calls us, draft a follow-up for the lead.", [
      { tool: "create_trigger", arguments: { when: "webhook", name: "Sales form leads", instructions: "Draft a follow-up for the lead in the event data." } },
      { tool: "list_triggers", arguments: {} },
    ]);
    expect(toolText(hooked, "create_trigger")).toContain("applied at once");
    const listed = toolText(hooked, "list_triggers");
    expect(listed).toContain('"kind": "schedule"');
    expect(listed).toContain('"kind": "webhook"');
    const webhookCard = (await messages()).findLast((message) => message.card?.webhookRequest)!.card;
    expect(webhookCard).toMatchObject({ autoApplied: true, answered: "allow", tool: "create_trigger" });
    const webhookId = webhookCard.webhookRequest.resultId as string;
    const { webhooks } = await api("GET", "/api/webhooks");
    const webhook = webhooks.find((candidate: any) => candidate.id === webhookId);
    expect(webhook).toMatchObject({ botId: bot.id, enabled: true, prompt: "Draft a follow-up for the lead in the event data." });
    const transcript = JSON.stringify({ hooked, messages: await messages() });
    expect(transcript, "a bot-made webhook's secret reached the transcript or the tool result").not.toMatch(/whsec_/);
    expect(await unanswered()).toEqual([]);

    // 3. The person's Copy link mints the secret; the real receiver accepts it and dedupes a retry.
    const { credential } = await api("POST", `/api/webhooks/${webhookId}/rotate`);
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { steps: [], reply: "Drafted the follow-up." } }));
    const call = (key: string) => fetch(credential.url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ lead: "Ada", email: "ada@example.com" }) });
    const first = await call("lead-1");
    expect(first.status).toBe(202);
    const accepted = await first.json() as any;
    expect(accepted).toMatchObject({ accepted: true, duplicate: false });
    const retry = await (await call("lead-1")).json() as any;
    expect(retry).toMatchObject({ duplicate: true, runId: accepted.runId });
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((run: any) => run.id === accepted.runId)?.status, { timeout: 20_000 }).toBe("completed");

    // 4. A schedule run shows on the live card, not as a card per run in the conversation that made it.
    const { run } = await api("POST", `/api/routines/${routineId}/run`, undefined, 201);
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === run.id)?.status, { timeout: 20_000 }).toBe("completed");
    expect((await messages()).some((message) => message.kind === "routine.run" && message.routineRun?.runId === run.id)).toBe(false);

    // 5. manage_trigger pauses it, at Ask, with no card.
    const paused = await turn("Pause the morning summary.", [{ tool: "manage_trigger", arguments: { trigger_id: routineId, action: "pause" } }]);
    expect(toolText(paused, "manage_trigger")).toContain("applied at once");
    expect((await api("GET", "/api/routines")).routines.find((routine: any) => routine.id === routineId).enabled).toBe(false);
    expect(await unanswered()).toEqual([]);

    // 6. Undo on the webhook's card removes it, and its link stops working.
    await api("POST", `/api/threads/${threadId}/undo`, { requestId: webhookCard.requestId });
    expect((await api("GET", "/api/webhooks")).webhooks.some((candidate: any) => candidate.id === webhookId)).toBe(false);
    expect((await call("lead-2")).status).toBe(401);
    expect((await messages()).find((message) => message.card?.requestId === webhookCard.requestId)!.card.undone).toBe(true);
  } finally {
    const evidencePath = `${fixture.info.logPath}.triggers.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
}, 120_000);
