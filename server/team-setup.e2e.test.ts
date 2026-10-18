import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

it("Clive sets up multi-provider teams at Ask with no card, keeps existing threads through setup and deletion, and a suggested specialist still waits on its card", async () => {
  const gates = mkdtempSync(join(tmpdir(), "omb-team-setup-gates-"));
  const gate = join(gates, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate }, undefined, undefined, undefined, undefined, undefined, ["codex"]);
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string, fromApp = true) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json",
      ...(fromApp ? { origin: fixture.info.url } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    // Never record provider environment/capabilities. Keep actions and safe results.
    evidence.push({ method, path, body, authority: token ? "turn capability" : fromApp ? "app review" : "originless loopback", status: response.status, result });
    expect(response.status, JSON.stringify(result)).toBe(expected); return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result }); return result;
  };
  try {
    const catalog = (await api("GET", "/api/instances")).instances;
    const claude = catalog.find((item: any) => item.instanceId === "claude");
    const codex = catalog.find((item: any) => item.instanceId === "codex");
    expect(codex).toBeDefined();
    const selection = (instance: any) => ({ instanceId: instance.instanceId, model: instance.models.default });
    const chief = (await api("POST", "/api/bots", { name: "Clive", title: "Chief of Staff", section: "Operations", modelSelection: selection(claude) }, 201)).bot;
    // At Ask: team setup applies at once, since OpenMausBot adds no card of its own.
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, approvalMode: "ask" });
    const state = async () => (await api("GET", "/api/bots")).bots;
    // The fixture pins its starter's name, but identity is the honest comparison: a name once collided with a random starter.
    const initialBotIds = new Set((await state()).map((bot: any) => bot.id));
    let previousPid: number | undefined;
    let guardedMessageId: string | undefined;
    const start = async (text: string, sendId?: string) => {
      if (existsSync(gate)) unlinkSync(gate);
      if (sendId) {
        const before = await api("GET", `/api/threads/${chief.threadId}/messages`);
        const accepted = await api("POST", `/api/bots/${chief.id}/messages/guarded`, {
          threadId: chief.threadId, sendId, text, expectedActiveLeafId: before.activeLeafId,
        }, 202);
        guardedMessageId = accepted.message.id;
      } else await control("send", "--bot", chief.id, "--task", chief.threadId, "--text", text);
      await expect.poll(() => {
        if (!existsSync(fixture.fixtureDumpPath)) return false;
        return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).pid !== previousPid;
      }, { timeout: 15_000 }).toBe(true);
      const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); previousPid = dump.pid;
      return dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN as string;
    };
    const finish = async () => {
      writeFileSync(gate, "finish");
      await expect.poll(async () => !(await state()).find((bot: any) => bot.id === chief.id).busy, { timeout: 20_000 }).toBe(true);
    };
    const continueOnce = async (requestId: string) => {
      await expect.poll(async () => {
        const bot = (await state()).find((bot: any) => bot.id === chief.id);
        return !bot.busy && bot.messages.filter((message: any) => message.role === "bot" && message.kind === "text" && message.text?.includes(`team setup decision ${requestId}:`)).length;
      }, { timeout: 20_000 }).toBe(1);
      const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); previousPid = dump.pid;
      evidence.push({ continuation: { requestId, prompt: dump.prompt, provider: "fixture claude", exactlyOneReply: true } });
    };
    const stopWithoutResume = async (requestId: string, threadId: string, target: "--bot" | "--channel", id: string) => {
      const stoppedPid = previousPid;
      await control("interrupt", target, id, "--task", threadId);
      writeFileSync(gate, "finish");
      await control("wait", target, id, "--task", threadId, "--timeout", "15");
      // Allow an erroneously queued provider handshake/reply to become visible.
      await new Promise((resolve) => setTimeout(resolve, 350));
      await api("POST", `/api/threads/${threadId}/respond`, { requestId, behavior: "deny" });
      const messages = (await api("GET", `/api/threads/${threadId}/messages`)).messages;
      expect(messages.some((message: any) => message.text?.includes(`team setup decision ${requestId}:`))).toBe(false);
      expect(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).pid).toBe(stoppedPid);
      expect((await state()).find((bot: any) => bot.id === chief.id).busy).toBe(false);
      evidence.push({ cancellation: { requestId, threadId, noNewProviderGeneration: true, noContinuationReply: true } });
    };
    const build = (name: string, team: string, modelSelection: unknown) => ({ action: "create", key: name, fields: {
      name, title: `${team} specialist`, soul: `Own ${team.toLowerCase()} work. Return evidence and state uncertainty.`, section: team, modelSelection,
    } });
    const plan = { reason: "Set up Research, Engineering and Growth specialists as requested", newTeams: ["Research", "Engineering", "Growth"], operations: [
      build("Mira", "Research", selection(claude)), build("Patch", "Engineering", selection(codex)), build("Quill", "Growth", selection(claude)),
      { action: "create", key: "Patch", fields: { title: "Implementation and verification engineer", chiefOfStaff: true } },
    ] };
    const decisionReplies = async (requestId: string) => ((await api("GET", `/api/threads/${chief.threadId}/messages`)).messages as any[])
      .filter((message) => message.text?.includes(`team setup decision ${requestId}:`)).length;
    let token = await start("Clive, set up Research, Engineering and Growth specialists with suitable engines and models.");
    const tools = await api("GET", "/api/internal/team-setup-catalog", undefined, 200, token);
    expect(tools.instances.map((item: any) => item.instanceId)).toEqual(expect.arrayContaining(["claude", "codex"]));
    await api("POST", "/api/internal/team-setup-requests", { plan: { ...plan, operations: [build("Bad", "Research", { instanceId: "codex", model: "invented-model" })] } }, 400, token);
    await api("POST", "/api/internal/team-setup-requests", { fromBotId: "foreign", plan }, 403, token);
    const applied = await api("POST", "/api/internal/team-setup-requests", { plan }, 201, token);
    expect(applied).toMatchObject({ state: "applied", applied: true });
    const saved = await state();
    const created = saved.filter((bot: any) => !initialBotIds.has(bot.id));
    expect(created.map((bot: any) => bot.name).sort()).toEqual(["Mira", "Patch", "Quill"]);
    const engineer = created.find((bot: any) => bot.name === "Patch");
    expect(engineer).toMatchObject({ title: "Implementation and verification engineer", section: "Engineering", chiefOfStaff: true, modelSelection: selection(codex), approvalMode: "full", autoApprove: false, composio: false });
    expect(engineer.managedSections).toBeUndefined();
    expect(saved.find((bot: any) => bot.id === chief.id).managedSections).toEqual(expect.arrayContaining(plan.newTeams));
    const notice = saved.find((bot: any) => bot.id === chief.id).messages.find((message: any) => message.card?.requestId === applied.requestId).card;
    expect(notice).toMatchObject({ autoApplied: true, answered: "allow", options: [], teamSetupRequest: { undo: { created: expect.any(Array) } } });
    expect(notice.subtitle).toContain("Authorize @Clive");
    expect(notice.subtitle).toContain("Chief of Staff: No → Yes");
    await finish();
    expect(await decisionReplies(applied.requestId)).toBe(0);

    token = await start("Move Patch to Growth and switch its default engine to Claude; retain its existing thread.");
    const updated = await api("POST", "/api/internal/team-setup-requests", { plan: { reason: "Requested default and team change", operations: [
      { action: "update", botId: engineer.id, fields: { section: "Growth", modelSelection: selection(claude) } },
      { action: "update", botId: engineer.id, fields: { description: "Shared delivery specialist" } },
    ] } }, 201, token);
    expect(updated.state).toBe("applied");
    await finish();
    const changed = (await state()).find((bot: any) => bot.id === engineer.id);
    expect(changed).toMatchObject({ section: "Growth", modelSelection: selection(claude), description: "Shared delivery specialist" });
    expect(changed.tasks.find((task: any) => task.threadId === engineer.threadId))
      .toMatchObject({ modelSelection: selection(claude), followsBotModel: true });
    // Patch changed since the first setup, so its Undo changes nothing.
    expect((await api("POST", `/api/threads/${chief.threadId}/undo`, { requestId: applied.requestId }, 409)).code).toBe("changed-since");
    expect((await state()).some((bot: any) => bot.name === "Mira")).toBe(true);

    token = await start("Delete Patch as requested.");
    const deletion = await api("POST", "/api/internal/bot-deletion-requests", { targetBotId: engineer.id, reason: "User explicitly requested deletion" }, 201, token);
    expect(deletion).toMatchObject({ state: "applied", applied: true, result: { bots: [{ id: engineer.id, name: "Patch", action: "deleted" }] } });
    expect(deletion.detail).toContain("Permanently removes");
    expect((await state()).some((bot: any) => bot.id === engineer.id)).toBe(false);
    expect((await state()).filter((bot: any) => initialBotIds.has(bot.id)).map((bot: any) => bot.id).sort())
      .toEqual([...initialBotIds].sort());
    await finish();

    // A specialist Clive suggests unasked is its question: it waits on its card, is answered only from the app with every bot idle, and resumes Clive once.
    const setupSendId = randomUUID();
    token = await start("Does the team need anyone else?", setupSendId);
    const requestSnapshot = () => api("GET", `/api/bots/${chief.id}/requests/${setupSendId}?threadId=${chief.threadId}`);
    const suggested = await api("POST", "/api/internal/create-bot", { name: "Scout", role: "Research scout", instructions: "Find and check sources.", suggestion: true }, 201, token);
    expect(suggested).toMatchObject({ state: "pending", applied: false });
    await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: suggested.requestId, behavior: "allow" }, 403);
    expect((await state()).some((bot: any) => bot.name === "Scout")).toBe(false);
    await finish();
    const waiting = await requestSnapshot();
    expect(waiting).toMatchObject({ messageId: guardedMessageId, phase: "waiting", activeTurnId: null, executionId: expect.any(String) });
    await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: suggested.requestId, behavior: "allow" }, 403, undefined, false);
    const approved = await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: suggested.requestId, behavior: "allow" });
    expect(approved.result.state).toBe("applied"); await continueOnce(suggested.requestId);
    const settled = await requestSnapshot();
    expect(settled).toMatchObject({ messageId: guardedMessageId, phase: "settled", activeTurnId: null, executionId: expect.any(String) });
    expect(settled.executionId).not.toBe(waiting.executionId);
    const replies = settled.messages.filter((message: any) => message.role === "bot" && message.kind === "text" && message.turnTerminal);
    expect(replies).toHaveLength(2);
    expect(replies.at(-1).text).toContain(`team setup decision ${suggested.requestId}:`);
    expect((await state()).find((bot: any) => bot.name === "Scout")).toMatchObject({ approvalMode: "full" });
    await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: suggested.requestId, behavior: "allow" });
    expect((await state()).filter((bot: any) => bot.name === "Scout")).toHaveLength(1);
    expect(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).pid).toBe(previousPid);
    const room = (await control("new-channel", "--name", "Chief review", "--members", chief.id)).channel;
    unlinkSync(gate);
    await control("send-channel", "--channel", room.id, "--task", room.activeTaskId, "--text", "@Clive Suggest a helper, then wait.");
    await expect.poll(() => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).pid, { timeout: 15_000 }).not.toBe(previousPid);
    const groupDump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); previousPid = groupDump.pid;
    const groupStopped = await api("POST", "/api/internal/create-bot", { name: "NoRestart", role: "Room helper", instructions: "Help the room.", suggestion: true },
      201, groupDump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN);
    await api("POST", `/api/threads/${room.activeTaskId}/respond`, { requestId: groupStopped.requestId, behavior: "deny" });
    await stopWithoutResume(groupStopped.requestId, room.activeTaskId, "--channel", room.id);
    expect((await state()).some((bot: any) => bot.name === "NoRestart")).toBe(false);
    await control("messages", "--bot", chief.id, "--task", chief.threadId, "--limit", "30");
    await control("wait", "--bot", chief.id, "--task", chief.threadId, "--timeout", "15");
    expect(readFileSync(fixture.info.logPath, "utf8")).not.toMatch(/ReferenceError|change listener threw/);
  } finally {
    const evidencePath = `${fixture.info.logPath}.team-setup.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ evidencePath, logPath: fixture.info.logPath }));
    await fixture.close(); await removeTempDir(gates);
  }
}, 150_000);
