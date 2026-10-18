import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection, ProviderAdapter, ProviderSnapshot } from "./contracts.ts";
import { createCoordinator, type Coordinator, type HostTurnResult } from "./coordinator.ts";
import { PROBE_TIMEOUT_MS } from "./engine-install.ts";
import { closeMessageDb } from "./message-db.ts";
import { createQuotaSwitch, NOT_NOW, quotaSwitchEnabled, type QuotaRequest, type QuotaSwitch, type QuotaSwitchDeps, type QuotaSwitchEngine } from "./quota-switch.ts";
import { Store, type BotRecord, type Message } from "./store.ts";

const QUOTA = "You've hit your weekly limit · resets Oct 12 at 2:30pm (Asia/Calcutta)";
const defaultSelection = (): ModelSelection => ({ instanceId: "claude", model: "claude-default" });
const caps = (extra: Partial<ProviderAdapter["capabilities"]> = {}): ProviderAdapter["capabilities"] =>
  ({ sessionModelSwitch: "unsupported", ...extra });
const available = async (): Promise<ProviderSnapshot> => ({ state: "available", authenticated: true });

function engine(instanceId: string, driverKind: string, displayName: string, overrides: Partial<QuotaSwitchEngine> = {}): QuotaSwitchEngine {
  return {
    instanceId, driverKind, displayName, enabled: true,
    models: { default: `${instanceId}-default`, options: [{ id: `${instanceId}-default`, label: "Default" }] },
    adapter: { capabilities: caps() },
    snapshot: available,
    ...overrides,
  };
}

describe("quotaSwitchEnabled", () => {
  afterEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("is on unless OMB_QUOTA_SWITCH=0 switches it off", () => {
    // On by default: the card is only an offer, and nothing changes until it is answered.
    expect(quotaSwitchEnabled({})).toBe(true);
    expect(quotaSwitchEnabled({ OMB_QUOTA_SWITCH: "0" })).toBe(false);
    expect(quotaSwitchEnabled({ OMB_QUOTA_SWITCH: " 0 " })).toBe(false);
    for (const other of ["1", "", "false", "off", "no"]) expect(quotaSwitchEnabled({ OMB_QUOTA_SWITCH: other }), JSON.stringify(other)).toBe(true);
  });

  it("takes nothing from config.json, which has no key for it", () => {
    // A key the config schema does not know is not a setting: the next save
    // through that schema may drop it, and the offer would come back unasked.
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ quotaSwitch: { enabled: false } }));
    expect(quotaSwitchEnabled({})).toBe(true);
  });
});

describe("quota-switch card", () => {
  let store: Store;
  let bot: BotRecord;
  let engines: QuotaSwitchEngine[];
  let resend: ReturnType<typeof vi.fn<QuotaSwitchDeps["resend"]>>;
  let gate: ReturnType<typeof vi.fn<QuotaSwitchDeps["gate"]>>;
  let switchRefusal: string | undefined;
  let enabled: boolean;
  let deps: QuotaSwitchDeps;
  let quota: QuotaSwitch;
  let coordinator: Coordinator;
  let requests: Map<string, QuotaRequest>;
  /** What TurnStops holds for the turn that is failing. */
  let cause: string;
  let turns: number;
  /** What a teammate's turn says when the runtime runs it; none starts until a test sets this. */
  let teammateSays: HostTurnResult | undefined;
  let parked: () => void;
  /** The injected clock: every wait the module starts, to fire by hand. */
  let timers: Array<{ ms: number; fire: () => void; cancelled: boolean }>;
  /** An engine whose probe never answers. */
  const silent = (instanceId: string, displayName: string) => engine(instanceId, "codex", displayName, { snapshot: () => new Promise(() => {}) });

  /** The thread as a turn sees it: its own model and approval level. */
  const thread = () => store.projectBotForTask(bot.id, bot.threadId)!;
  /** A person's turn as startTurn admits it: a root of the job runtime, and
   * the thread's request record naming the message it answers. */
  const begin = (threadId = bot.threadId, record: Partial<QuotaRequest> = {}) => {
    const id = `g${++turns}`;
    coordinator.beginTurn({ id, address: { botId: bot.id, threadId }, brief: "asked", level: "ask", origin: { kind: "user", request: "asked" } });
    requests.set(threadId, { generations: new Set([id]), turnId: `turn-${id}`, origin: { kind: "user", request: "asked" }, ...record });
    return { id, event: { threadId, turnId: `turn-${id}`, ok: false, stopReason: "quota" } };
  };
  /** The fold's report of that turn, broken on `why`. */
  const fails = (turn: ReturnType<typeof begin>, why = QUOTA, internal = false, on = thread()) => {
    cause = why;
    return quota.turnFailed(on, turn.event, internal);
  };
  /** A turn that failed and handed nothing on: its own end settles its root. */
  const failed = (why = QUOTA, record: Partial<QuotaRequest> = {}) => {
    const turn = begin(bot.threadId, record);
    coordinator.endTurn(turn.id, { ok: false, text: why });
    return fails(turn, why);
  };
  const said = (text: string, extra: Partial<Message> = {}) =>
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text, ...extra }).id;
  const cards = () => store.messagesFor(bot.threadId).filter((m) => m.kind === "options" && m.card?.quotaSwitch);
  const pending = () => cards().find((m) => !m.card!.answered && !m.card!.dismissed);
  const notices = () => store.messagesFor(bot.threadId).flatMap((m) => m.kind === "activity" && m.tool ? [m.tool] : []);
  const cardNow = (card: Message) => store.messagesFor(bot.threadId).find((m) => m.id === card.id)!.card!;
  /** The person presses `label`; resolves with what the endpoint answers. */
  const answer = async (card: Message, label: string) => {
    const taken = quota.answer(bot.threadId, card.card!.requestId!, "answer", label);
    expect(taken).not.toBeNull();
    return taken!;
  };

  beforeEach(() => {
    store = new Store(defaultSelection);
    bot = store.patchBot(store.createBot().id, { name: "Wren", modelSelection: defaultSelection() })!;
    engines = [engine("claude", "claudeAgent", "Claude"), engine("codex", "codex", "Codex"), engine("cursor", "cursorAgent", "Cursor")];
    resend = vi.fn<QuotaSwitchDeps["resend"]>(async () => undefined);
    gate = vi.fn<QuotaSwitchDeps["gate"]>((_thread, selection) => switchRefusal ? { ok: false, error: switchRefusal } : { ok: true, selection });
    switchRefusal = undefined;
    enabled = true;
    requests = new Map();
    cause = QUOTA;
    turns = 0;
    teammateSays = undefined;
    parked = () => {};
    timers = [];
    // No teammate's turn starts until a test says what it answers.
    coordinator = createCoordinator({
      dataDir: ":memory:", log: () => {},
      host: {
        validate: () => undefined, busy: () => teammateSays === undefined, run: async () => teammateSays!,
        report: () => {}, changed: () => {}, park: () => parked(),
        names: (node, parent) => ({ requester: parent?.botId ?? "Omkar", assignee: node.botId, person: "Omkar" }),
        levelOf: () => ({ level: "ask" }), chiefOf: () => false,
      },
    });
    deps = {
      store, coordinator,
      registry: { instances: () => engines },
      turnStops: { failureCause: () => cause },
      enabled: () => enabled,
      gate,
      // index.ts's threadBusy; the store's own flag is what a turn's admission sets
      busy: (botId, threadId) => store.taskByThread(botId, threadId)?.busy === true,
      request: (threadId) => requests.get(threadId),
      resend,
      after: (ms, fire) => {
        const timer = { ms, fire, cancelled: false };
        timers.push(timer);
        return { cancel: () => { timer.cancelled = true; } };
      },
    };
    quota = createQuotaSwitch(deps);
  });

  afterEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  describe("what is offered", () => {
    it("offers the other engines that can run now, never the current one, and takes no free text", async () => {
      const messageId = said("how's the weather");
      const card = await failed(QUOTA, { messageId });
      expect(card?.card).toMatchObject({
        title: "Claude is out of quota",
        subtitle: "Continue this conversation on another engine?",
        options: ["Codex", "Cursor", NOT_NOW],
        fixedOptions: true,
        // the failed request's own root in the job runtime rides the card
        quotaSwitch: { engines: [{ instanceId: "codex", name: "Codex" }, { instanceId: "cursor", name: "Cursor" }], messageId, rootId: "g1" },
      });
      expect(card!.card!.requestId).toBeTruthy();
      expect(card!.card!.tool).toBeUndefined();
      expect(pending()?.id).toBe(card!.id);
    });

    it("offers at most three engines, then Not now", async () => {
      engines.push(engine("grok", "grokAgent", "Grok"), engine("gemini", "geminiAgent", "Gemini"));
      expect((await failed())!.card!.options).toEqual(["Codex", "Cursor", "Grok", NOT_NOW]);
    });

    it("raises no second card in a thread while one is pending", async () => {
      expect(await failed()).toBeTruthy();
      expect(await failed()).toBeNull();
      expect(cards()).toHaveLength(1);
    });

    it("raises one card when two failures of the same thread are read at once", async () => {
      const raised = await Promise.all([failed(), failed()]);
      expect(raised.filter(Boolean)).toHaveLength(1);
      expect(cards()).toHaveLength(1);
    });

    it("raises no card for an error that is not a quota or usage limit", async () => {
      expect(await failed("500 internal server error")).toBeNull();
      expect(await failed("Not logged in · Please run /login")).toBeNull();
      expect(cards()).toHaveLength(0);
    });

    it("raises no card when no other engine is configured", async () => {
      engines = [engines[0]!];
      expect(await failed()).toBeNull();
    });

    it("never offers an engine that cannot run a turn when the card is built", async () => {
      engines = [
        engines[0]!,
        engine("gone", "codex", "Uninstalled", { snapshot: async () => ({ state: "unavailable", reason: "not installed" }) }),
        engine("out", "codex", "Signed out", { snapshot: async () => ({ state: "available", authenticated: false }) }),
        engine("off", "codex", "Switched off", { enabled: false }),
        engine("broken", "codex", "Broken", { snapshot: async () => { throw new Error("probe failed"); } }),
        engine("empty", "codex", "No model", { models: { default: "", options: [] } }),
        engine("barred", "codex", "Barred"),
        engine("codex", "codex", "Codex"),
      ];
      deps.refusal = (candidate) => candidate.instanceId === "barred" ? "Your organisation does not allow this engine." : undefined;
      expect((await failed())!.card!.options).toEqual(["Codex", NOT_NOW]);
    });

    it("offers a custom endpoint whatever its sign-in state says: it brings its own credential", async () => {
      engines = [engines[0]!, engine("local", "codex", "Local model", { snapshot: async () => ({ state: "available", authenticated: false }) })];
      deps.access = (instanceId) => instanceId === "local" ? "custom" : "subscription";
      expect((await failed())!.card!.options).toEqual(["Local model", NOT_NOW]);
    });

    it("builds the card without an engine that does not say how it is in time", async () => {
      engines[1] = silent("codex", "Codex");
      const raising = failed(QUOTA, { messageId: said("hi") });
      // Codex was asked first; its wait is the one an engine probe gets elsewhere.
      expect(timers[0]).toMatchObject({ ms: PROBE_TIMEOUT_MS, cancelled: false });
      timers[0]!.fire();
      expect((await raising)!.card!.options).toEqual(["Cursor", NOT_NOW]);
      // an engine that answered stopped its clock
      expect(timers[1]).toMatchObject({ cancelled: true });
    });

    it("raises no card when every other engine is unavailable", async () => {
      engines = engines.map((candidate) => candidate.instanceId === "claude" ? candidate
        : { ...candidate, snapshot: async () => ({ state: "unavailable" as const }) });
      expect(await failed()).toBeNull();
    });

    it("never offers an engine known to be at its own limit, and offers it again once a turn on it succeeds", async () => {
      const codexThread = store.createTask(bot.id, undefined, false)!.threadId;
      store.switchTaskModel(bot.id, codexThread, { instanceId: "codex", model: "codex-default" }, false, false);
      const onCodex = store.projectBotForTask(bot.id, codexThread)!;
      // Codex runs out in another conversation; that one is offered Claude and Cursor.
      const elsewhere = await fails(begin(codexThread), "usage limit reached", false, onCodex);
      expect(elsewhere!.card!.options).toEqual(["Claude", "Cursor", NOT_NOW]);
      // Now Claude runs out here: Codex is known to be limited, so only Cursor is offered.
      const first = (await failed())!;
      expect(first.card!.options).toEqual(["Cursor", NOT_NOW]);
      await answer(first, NOT_NOW);
      // A turn on Codex completes: it works again.
      quota.turnSucceeded(onCodex, codexThread);
      expect((await failed())!.card!.options).toEqual(["Codex", "Cursor", NOT_NOW]);
    });

    it.each<[string, { internal?: boolean; record?: Partial<QuotaRequest> | null }]>([
      ["a teammate's or a peer's turn", { internal: true }],
      ["a routine's, a webhook's or a relayed request", { record: { origin: { kind: "outside" } } }],
      ["a request whose record names another provider turn", { record: { turnId: "another-turn" } }],
      ["a request the person stopped", { record: { stopped: true } }],
      ["a turn with no request record", { record: null }],
    ])("raises no card for %s, and still remembers that its engine ran out", async (_name, { internal = false, record = {} }) => {
      const codexThread = store.createTask(bot.id, undefined, false)!.threadId;
      store.switchTaskModel(bot.id, codexThread, { instanceId: "codex", model: "codex-default" }, false, false);
      const turn = begin(codexThread, record ?? {});
      if (record === null) requests.delete(codexThread);
      expect(await fails(turn, QUOTA, internal, store.projectBotForTask(bot.id, codexThread)!)).toBeNull();
      expect(store.messagesFor(codexThread)).toEqual([]);
      expect((await failed())!.card!.options).toEqual(["Cursor", NOT_NOW]);
    });

    it("raises no card when the engine the thread runs on is no longer here: there is nothing to check a backup against", async () => {
      engines = engines.filter((candidate) => candidate.instanceId !== "claude");
      expect(await failed()).toBeNull();
      expect(cards()).toHaveLength(0);
    });

    it("posts no card for a thread that went on while the engines were being read", async () => {
      // Codex takes a while to say how it is; meanwhile the person's next turn works.
      let known!: (snapshot: ProviderSnapshot) => void;
      const slow = () => engine("codex", "codex", "Codex", { snapshot: () => new Promise((resolve) => { known = resolve; }) });
      engines[1] = slow();
      const raising = failed(QUOTA, { messageId: said("hi") });
      quota.turnSucceeded(thread(), bot.threadId);
      known({ state: "available", authenticated: true });
      expect(await raising).toBeNull();
      expect(cards()).toHaveLength(0);
      // a turn that works in another thread makes nothing stale here
      engines[1] = slow();
      const again = failed(QUOTA, { messageId: said("hi again") });
      const otherThread = store.createTask(bot.id, undefined, false)!.threadId;
      quota.turnSucceeded(store.projectBotForTask(bot.id, otherThread)!, otherThread);
      known({ state: "available", authenticated: true });
      expect(await again).toBeTruthy();
    });

    it("offers only engines that pass the backup check: the same tools, the same workspace", async () => {
      engines = [
        engine("claude", "claudeAgent", "Claude", { adapter: { capabilities: caps({ agentsMcp: true, images: true }) } }),
        engine("bare", "codex", "No team tools", { adapter: { capabilities: caps({ images: true }) } }),
        // an API model has no working folder (supportsWorkspaceFiles)
        engine("api", "openai-compat", "API model", { adapter: { capabilities: caps({ agentsMcp: true, images: true }) } }),
        engine("codex", "codex", "Codex", { adapter: { capabilities: caps({ agentsMcp: true, images: true, browserMcp: true }) } }),
      ];
      expect((await failed())!.card!.options).toEqual(["Codex", NOT_NOW]);
    });

    it("never offers an engine this conversation's approval level cannot move to", async () => {
      // Auto-accept edits exists on Claude and Grok, not on Codex or Cursor.
      store.patchTask(bot.id, bot.threadId, { approvalMode: "edits", autoApprove: false });
      engines.push(engine("grok", "grokAgent", "Grok"));
      expect((await failed())!.card!.options).toEqual(["Grok", NOT_NOW]);
    });

    it("tells two engines with the same name apart", async () => {
      engines = [engines[0]!, engine("work", "codex", "Codex"), engine("home", "codex", "Codex")];
      const card = (await failed())!;
      expect(card.card!.options).toEqual(["Codex", "Codex (home)", NOT_NOW]);
      await answer(card, "Codex (home)");
      expect(thread().modelSelection).toEqual({ instanceId: "home", model: "home-default" });
    });

    it("raises nothing when it is switched off", async () => {
      enabled = false;
      expect(await failed()).toBeNull();
      expect(cards()).toHaveLength(0);
    });

    it("says on the card to send the message again when there is none to resend", async () => {
      const card = (await failed(QUOTA, { messageId: undefined }))!;
      expect(card.card!.subtitle).toBe("Switch this conversation to another engine? Send your message again afterwards.");
      expect(card.card!.quotaSwitch!.messageId).toBeUndefined();
    });

    it("raises no card for a turn that answered a bot's line, which is never the person's to send again", async () => {
      const peerLine = said("Do the quarterly numbers", { peerAsk: { botId: "chief", name: "Chief" } });
      expect(await failed(QUOTA, { messageId: peerLine })).toBeNull();
      expect(cards()).toHaveLength(0);
    });
  });

  describe("the person's answer", () => {
    it("switches this conversation through the model-switch gate and resends the exact message that failed", async () => {
      const quoted = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "It will rain on Friday." }).id;
      const messageId = said("how's the weather", { dataContext: { cardId: "sales" }, replyToId: quoted });
      const card = (await failed(QUOTA, { messageId }))!;

      await answer(card, "Codex");

      // through the gate, asked for this thread as it stood and the engine's default model
      expect(gate).toHaveBeenCalledTimes(1);
      expect(gate.mock.calls[0]![0]).toMatchObject({ id: bot.id, threadId: bot.threadId, modelSelection: { instanceId: "claude" } });
      expect(gate.mock.calls[0]![1]).toEqual({ instanceId: "codex", model: "codex-default" });
      // this conversation moved; the bot's own model and its other conversations did not
      expect(thread().modelSelection).toEqual({ instanceId: "codex", model: "codex-default" });
      expect(store.bot(bot.id)!.modelSelection).toEqual({ instanceId: "claude", model: "claude-default" });
      expect(resend).toHaveBeenCalledTimes(1);
      const [botId, threadId, message, replyTo, spoken] = resend.mock.calls[0]!;
      expect([botId, threadId]).toEqual([bot.id, bot.threadId]);
      expect(message).toMatchObject({ id: messageId, text: "how's the weather", dataContext: { cardId: "sales" } });
      expect(replyTo).toMatchObject({ id: quoted, text: "It will rain on Friday." });
      // typed, so sent again as typed
      expect(spoken).toEqual({});

      const settled = store.messagesFor(bot.threadId).find((m) => m.id === card.id)!.card!;
      expect(settled).toMatchObject({ answered: "answer", answeredText: "Codex" });
      expect(pending()).toBeUndefined();
      expect(notices()).toContainEqual({ name: "notice: continuing on Codex after hitting quota", ok: true });
    });

    it("resends a request spoken on a Live call as spoken, on the same call", async () => {
      // Spoken words never reach the log; the line sent again says it was spoken too.
      const card = (await failed(QUOTA, { messageId: said("book the usual table", { via: "call", callId: "call-7" }) }))!;
      await answer(card, "Codex");
      expect(resend.mock.calls[0]![2].text).toBe("book the usual table");
      expect(resend.mock.calls[0]![4]).toEqual({ via: "call", callId: "call-7" });
    });

    it("carries no call id for a line that was not spoken, even one stored with an id", async () => {
      const card = (await failed(QUOTA, { messageId: said("typed line", { callId: "call-7" }) }))!;
      await answer(card, "Codex");
      expect(resend.mock.calls[0]![4]).toEqual({});
    });

    it("resends an image-only message, transport tag and all", async () => {
      const text = '<attached-image path="/tmp/x.png" name="x.png"/>';
      const card = (await failed(QUOTA, { messageId: said(text) }))!;
      await answer(card, "Codex");
      expect(resend.mock.calls[0]![2].text).toBe(text);
    });

    it("resends the message whose turn failed, not a newer one written while the card was open", async () => {
      const card = (await failed(QUOTA, { messageId: said("original question") }))!;
      said("a completely different, later message");
      await answer(card, "Codex");
      expect(resend).toHaveBeenCalledTimes(1);
      expect(resend.mock.calls[0]![2].text).toBe("original question");
    });

    it("when the message is gone, switches, posts no 'continuing' line and says to send it again", async () => {
      const messageId = said("will be rewound away");
      const card = (await failed(QUOTA, { messageId }))!;
      store.patchMessage(bot.threadId, messageId, { text: "" });

      await answer(card, "Codex");

      expect(resend).not.toHaveBeenCalled();
      expect(thread().modelSelection.instanceId).toBe("codex");
      expect(notices().some((tool) => tool.name.includes("continuing on"))).toBe(false);
      expect(notices()).toContainEqual({
        name: "notice: switched to Codex, but the message that hit quota could not be found to resend — send it again.", ok: false,
      });
    });

    it("switches and says to send the message again when the card had none to resend", async () => {
      const card = (await failed(QUOTA, { messageId: undefined }))!;
      await answer(card, "Codex");
      expect(resend).not.toHaveBeenCalled();
      expect(thread().modelSelection).toEqual({ instanceId: "codex", model: "codex-default" });
      expect(notices().some((tool) => tool.name.includes("continuing on"))).toBe(false);
      expect(notices().some((tool) => tool.name.includes("send it again"))).toBe(true);
    });

    it("leaves the offer open when the model-switch gate refuses, says why, and takes the same answer once it passes", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      const sent: Message[] = [];
      store.onChange((change) => { if (change.type === "message.patch" && change.message.id === card.id) sent.push(change.message); });
      switchRefusal = "the bot is working — stop it before changing models";

      expect(await answer(card, "Codex")).toBe("unavailable");

      expect(thread().modelSelection).toEqual({ instanceId: "claude", model: "claude-default" });
      expect(resend).not.toHaveBeenCalled();
      expect(notices()).toContainEqual({
        name: "notice: could not switch to Codex — the bot is working — stop it before changing models", ok: false,
      });
      // Not spent: a transient refusal must not cost the person the offer.
      expect(pending()?.id).toBe(card.id);
      expect(sent.map((message) => message.card?.answered)).toEqual([undefined]);

      switchRefusal = undefined;
      expect(await answer(card, "Codex")).toBe("answered");
      expect(thread().modelSelection.instanceId).toBe("codex");
      expect(cardNow(card)).toMatchObject({ answered: "answer", answeredText: "Codex" });
      expect(resend).toHaveBeenCalledTimes(1);
    });

    it("says so when the switch could not be saved, and resends nothing", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      vi.spyOn(store, "switchTaskModel").mockImplementationOnce(() => { throw new Error("ENOSPC: no space left on device"); });

      await answer(card, "Codex");

      expect(thread().modelSelection.instanceId).toBe("claude");
      expect(resend).not.toHaveBeenCalled();
      expect(notices()).toContainEqual({ name: "notice: could not switch to Codex — the model switch could not be saved.", ok: false });
      expect(pending()?.id).toBe(card.id);
    });

    it("switches nothing when the chosen engine stopped being available while the card was open", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      engines[1] = engine("codex", "codex", "Codex", { snapshot: async () => ({ state: "unavailable", reason: "signed out" }) });

      await answer(card, "Codex");

      expect(thread().modelSelection).toEqual({ instanceId: "claude", model: "claude-default" });
      expect(resend).not.toHaveBeenCalled();
      expect(notices()).toContainEqual({ name: "notice: Codex is no longer available — nothing switched.", ok: false });
      // the other engine on the card can still be chosen
      await answer(card, "Cursor");
      expect(thread().modelSelection.instanceId).toBe("cursor");
      expect(resend).toHaveBeenCalledTimes(1);
    });

    it("closes the card and says so when the engine the thread runs on was removed while the card was open", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      engines = engines.filter((candidate) => candidate.instanceId !== "claude");

      expect(await answer(card, "Codex")).toBe("unavailable");

      expect(thread().modelSelection.instanceId).toBe("claude");
      expect(gate).not.toHaveBeenCalled();
      expect(resend).not.toHaveBeenCalled();
      // It is the conversation's own engine that is gone, not Codex: no backup
      // can be checked against it, now or on the next press.
      expect(notices()).toEqual([{
        name: "notice: this conversation's own engine is no longer configured here, so no other engine can be checked against it — nothing switched. Choose a model for this conversation instead.",
        ok: false,
      }]);
      expect(cardNow(card)).toMatchObject({ answered: "unavailable", dismissed: true });
    });

    it("takes a removed engine off the card instead of refusing it on every press", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      engines = engines.filter((candidate) => candidate.instanceId !== "codex");

      expect(await answer(card, "Codex")).toBe("unavailable");

      expect(thread().modelSelection.instanceId).toBe("claude");
      expect(resend).not.toHaveBeenCalled();
      expect(notices()).toEqual([{ name: "notice: Codex is no longer configured — nothing switched.", ok: false }]);
      // Gone for good, so it leaves the card; what is left can still be chosen.
      expect(pending()?.id).toBe(card.id);
      expect(cardNow(card)).toMatchObject({ options: ["Cursor", NOT_NOW], quotaSwitch: { engines: [{ instanceId: "cursor", name: "Cursor" }] } });
      expect(await answer(card, "Cursor")).toBe("answered");
      expect(thread().modelSelection.instanceId).toBe("cursor");
      expect(resend).toHaveBeenCalledTimes(1);
    });

    it("closes the card when the only engine on it was removed", async () => {
      engines = [engines[0]!, engines[1]!];
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      expect(card.card!.options).toEqual(["Codex", NOT_NOW]);
      engines = [engines[0]!];

      expect(await answer(card, "Codex")).toBe("unavailable");

      expect(notices()).toEqual([{ name: "notice: Codex is no longer configured, and the card offered no other engine — nothing switched.", ok: false }]);
      expect(cardNow(card)).toMatchObject({ answered: "unavailable", dismissed: true });
      expect(pending()).toBeUndefined();
    });

    it("refuses when the chosen engine does not say how it is in time, and leaves the offer open", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      engines[1] = silent("codex", "Codex");

      const pressed = quota.answer(bot.threadId, card.card!.requestId!, "answer", "Codex")!;
      // one wait is running, the one an engine probe gets elsewhere; it runs out
      const waiting = timers.filter((timer) => !timer.cancelled);
      expect(waiting.map((timer) => timer.ms)).toEqual([PROBE_TIMEOUT_MS]);
      waiting[0]!.fire();

      expect(await pressed).toBe("unavailable");
      expect(thread().modelSelection.instanceId).toBe("claude");
      expect(gate).not.toHaveBeenCalled();
      expect(resend).not.toHaveBeenCalled();
      expect(notices()).toEqual([{ name: "notice: Codex did not answer in time — nothing switched. Try again in a moment.", ok: false }]);
      // the card is free again: another engine on it can be chosen
      expect(pending()?.id).toBe(card.id);
      expect(await answer(card, "Cursor")).toBe("answered");
      expect(thread().modelSelection.instanceId).toBe("cursor");
    });

    it("sends nothing again into a thread that is already working on the chosen engine", async () => {
      // The person changed the engine by hand and typed the message again.
      // While that turn runs they press the same engine on the card, still open.
      const card = (await failed(QUOTA, { messageId: said("how's the weather") }))!;
      store.switchTaskModel(bot.id, bot.threadId, { instanceId: "codex", model: "codex-default" }, false, false);
      begin(bot.threadId, { messageId: said("how's the weather") });
      store.setTaskActivity(bot.id, bot.threadId, "working");

      expect(await answer(card, "Codex")).toBe("answered");

      expect(gate).not.toHaveBeenCalled();
      expect(resend).not.toHaveBeenCalled();
      expect(cardNow(card)).toMatchObject({ answered: "answer", answeredText: "Codex" });
      expect(notices()).toEqual([{ name: "notice: already on Codex. This conversation is working, so your message was not sent again.", ok: true }]);
    });

    it("still resends into an idle thread the person had already moved to the chosen engine", async () => {
      const card = (await failed(QUOTA, { messageId: said("how's the weather") }))!;
      store.switchTaskModel(bot.id, bot.threadId, { instanceId: "codex", model: "codex-default" }, false, false);

      expect(await answer(card, "Codex")).toBe("answered");

      expect(gate).not.toHaveBeenCalled();
      expect(resend).toHaveBeenCalledTimes(1);
      expect(notices()).toEqual([{ name: "notice: continuing on Codex after hitting quota", ok: true }]);
    });

    it("switches nothing when the chosen engine ran into its own limit while the card was open", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      const codexThread = store.createTask(bot.id, undefined, false)!.threadId;
      store.switchTaskModel(bot.id, codexThread, { instanceId: "codex", model: "codex-default" }, false, false);
      await fails(begin(codexThread), QUOTA, true, store.projectBotForTask(bot.id, codexThread)!);

      await answer(card, "Codex");

      expect(thread().modelSelection.instanceId).toBe("claude");
      expect(resend).not.toHaveBeenCalled();
      expect(notices()).toContainEqual({ name: "notice: Codex is no longer available — nothing switched.", ok: false });
    });

    describe("a request the job runtime still holds", () => {
      const here = () => ({ botId: bot.id, threadId: bot.threadId });
      /** A teammate with its own conversation. */
      const mate = () => { const made = store.createBot(); return { botId: made.id, threadId: made.threadId }; };

      it("switches but resends nothing while the failed turn's request waits on the teammates it handed work to", async () => {
        // The turn asked a teammate, then ran out: its root waits on that work
        // and the runtime resumes it. A resend would start the request twice.
        const turn = begin(bot.threadId, { messageId: said("ask the team for the numbers") });
        coordinator.enqueue(here(), turn.id, undefined, mate(), "Pull the quarter's numbers");
        coordinator.endTurn(turn.id, { ok: false, text: QUOTA });
        expect(coordinator.node(turn.id)).toMatchObject({ status: "waiting" });
        const card = (await fails(turn))!;
        expect(card.card!.quotaSwitch!.rootId).toBe(turn.id);

        await answer(card, "Codex");

        expect(thread().modelSelection.instanceId).toBe("codex");
        expect(resend).not.toHaveBeenCalled();
        expect(cardNow(card)).toMatchObject({ answered: "answer", answeredText: "Codex" });
        expect(notices()).toEqual([{ name: "notice: switched to Codex. Your request is still under way here and continues on Codex.", ok: true }]);
      });

      it("switches but resends nothing while the failed turn's request is parked on a card that turn left", async () => {
        const turn = begin(bot.threadId, { messageId: said("mail the summary") });
        coordinator.endTurn(turn.id, { ok: false, text: QUOTA, cards: { question: "Waiting on the person: connect Gmail", ids: ["connector-card"] } });
        expect(coordinator.node(turn.id)).toMatchObject({ status: "waiting", cards: ["connector-card"] });
        const card = (await fails(turn))!;

        await answer(card, "Codex");

        expect(thread().modelSelection.instanceId).toBe("codex");
        expect(resend).not.toHaveBeenCalled();
        expect(notices()).toEqual([{
          name: "notice: switched to Codex. Your request waits on a card above and continues on Codex once you act on it.", ok: true,
        }]);
      });

      it("resends when only another, older request of the thread is still parked on its card", async () => {
        // An earlier turn left a connector card nobody answered: its root is
        // parked for good. That is not the request that ran out.
        const earlier = begin();
        coordinator.endTurn(earlier.id, { ok: true, text: "", cards: { question: "Waiting on the person: connect Gmail", ids: ["connector-card"] } });
        const card = (await failed(QUOTA, { messageId: said("how's the weather") }))!;
        expect(coordinator.node(earlier.id)).toMatchObject({ status: "waiting" });
        expect(coordinator.node(card.card!.quotaSwitch!.rootId!)).toMatchObject({ status: "failed" });

        await answer(card, "Codex");

        expect(resend).toHaveBeenCalledTimes(1);
        expect(resend.mock.calls[0]![2].text).toBe("how's the weather");
        expect(notices()).toEqual([{ name: "notice: continuing on Codex after hitting quota", ok: true }]);
      });

      it("resends when the failed request's root has since left the runtime", async () => {
        const card = (await failed(QUOTA, { messageId: said("hi") }))!;
        expect(coordinator.prune(Date.now() + 60_000)).toBe(1);
        await answer(card, "Codex");
        expect(resend).toHaveBeenCalledTimes(1);
      });

      it("resends nothing a teammate's open question would take as its answer, and says so", async () => {
        const card = (await failed(QUOTA, { messageId: said("how's the weather") }))!;
        // Afterwards a Chief hands this bot work here, and its turn ends on a
        // question for the person: their next typed line in this thread answers it.
        const chief = mate();
        coordinator.beginTurn({ id: "chief-turn", address: chief, brief: "plan the week", level: "ask" });
        coordinator.enqueue(chief, "chief-turn", undefined, here(), "Which quarter do you need?");
        const asked = new Promise<void>((resolve) => { parked = resolve; });
        teammateSays = { ok: true, text: "NEEDS INPUT: Which quarter do you mean?" };
        coordinator.tick();
        await asked;

        await answer(card, "Codex");

        expect(thread().modelSelection.instanceId).toBe("codex");
        expect(resend).not.toHaveBeenCalled();
        expect(notices()).toEqual([{
          name: "notice: switched to Codex. A teammate's question is waiting for your answer in this conversation, so your message was not sent again — answer it, then send your message again.",
          ok: false,
        }]);
      });
    });

    it("says so when the resend could not start", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      resend.mockRejectedValueOnce(new Error("this bot has reached its limit of 3 parallel threads"));

      await answer(card, "Codex");

      expect(thread().modelSelection.instanceId).toBe("codex");
      expect(notices()).toContainEqual({
        name: "notice: could not continue on Codex — this bot has reached its limit of 3 parallel threads", ok: false,
      });
    });

    it("'Not now' settles the card and changes nothing", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      await answer(card, NOT_NOW);
      expect(cardNow(card)).toMatchObject({ answered: "answer", answeredText: NOT_NOW });
      expect(thread().modelSelection).toEqual({ instanceId: "claude", model: "claude-default" });
      expect(resend).not.toHaveBeenCalled();
      expect(notices()).toEqual([]);
    });

    it.each(["deny", "allow"] as const)("reads a %s as 'Not now' even when it carries an offered engine's label", async (behavior) => {
      // Only an answer may name an engine. On a server where local services
      // may only decline cards, a bot's own shell can read this card and post
      // to it: its decline must never choose the engine or resend the message.
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;

      expect(await quota.answer(bot.threadId, card.card!.requestId!, behavior, "Codex")).toBe("rejected");

      expect(cardNow(card)).toMatchObject({ answered: "answer", answeredText: NOT_NOW });
      expect(thread().modelSelection).toEqual({ instanceId: "claude", model: "claude-default" });
      expect(gate).not.toHaveBeenCalled();
      expect(resend).not.toHaveBeenCalled();
      expect(notices()).toEqual([]);
    });

    it("reads an answer that carries no words as 'Not now'", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      for (const message of [undefined, 0, ["Codex"], { label: "Codex" }]) {
        const taken = quota.answer(bot.threadId, card.card!.requestId!, "answer", message);
        // the first settles it; after that the card is no longer this module's
        if (message === undefined) expect(await taken).toBe("answered");
        else expect(taken).toBeNull();
      }
      expect(cardNow(card).answeredText).toBe(NOT_NOW);
      expect(gate).not.toHaveBeenCalled();
    });

    it("takes a second press on the same card while the first is being read as the same answer", async () => {
      let known!: (snapshot: ProviderSnapshot) => void;
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      engines[1] = engine("codex", "codex", "Codex", { snapshot: () => new Promise((resolve) => { known = resolve; }) });

      const first = quota.answer(bot.threadId, card.card!.requestId!, "answer", "Codex")!;
      // still open while Codex is being read; a second press does not go to the late-answer lane
      expect(pending()?.id).toBe(card.id);
      const second = quota.answer(bot.threadId, card.card!.requestId!, "answer", "Codex");
      expect(second).toBe(first);
      known({ state: "available", authenticated: true });
      expect(await Promise.all([first, second])).toEqual(["answered", "answered"]);

      expect(thread().modelSelection.instanceId).toBe("codex");
      expect(gate).toHaveBeenCalledTimes(1);
      expect(resend).toHaveBeenCalledTimes(1);
    });

    it("lets a 'Not now' pressed while an engine is being read win", async () => {
      let known!: (snapshot: ProviderSnapshot) => void;
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      engines[1] = engine("codex", "codex", "Codex", { snapshot: () => new Promise((resolve) => { known = resolve; }) });

      const chosen = quota.answer(bot.threadId, card.card!.requestId!, "answer", "Codex")!;
      expect(await answer(card, NOT_NOW)).toBe("answered");
      known({ state: "available", authenticated: true });
      expect(await chosen).toBe("unavailable");

      expect(cardNow(card)).toMatchObject({ answered: "answer", answeredText: NOT_NOW });
      expect(thread().modelSelection.instanceId).toBe("claude");
      expect(gate).not.toHaveBeenCalled();
      expect(resend).not.toHaveBeenCalled();
      expect(notices()).toEqual([]);
    });

    it("reads an answer that names none of the offered engines as 'Not now'", async () => {
      // A phone still shows a text box on this card: typed words never switch.
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      await answer(card, "use whatever is fastest");
      expect(cardNow(card).answeredText).toBe(NOT_NOW);
      expect(thread().modelSelection.instanceId).toBe("claude");
      expect(resend).not.toHaveBeenCalled();
    });

    it("frees the thread for a new card once the pending one is answered", async () => {
      const first = (await failed())!;
      await answer(first, NOT_NOW);
      expect(await failed()).toBeTruthy();
      expect(cards()).toHaveLength(2);
    });

    it("leaves a request that is not a pending quota card to its own resolver", async () => {
      expect(quota.answer(bot.threadId, "not-a-quota-request", "answer", "Codex")).toBeNull();
      const other = store.appendMessage(bot.threadId, {
        role: "bot", kind: "options", card: { title: "Which file?", subtitle: "", options: ["a.ts"], requestId: "provider-ask" },
      });
      expect(quota.answer(bot.threadId, other.card!.requestId!, "answer", "a.ts")).toBeNull();
      const card = (await failed())!;
      await answer(card, NOT_NOW);
      // answered once: a second press belongs to the settled-card path
      expect(quota.answer(bot.threadId, card.card!.requestId!, "answer", "Codex")).toBeNull();
      // and a card is only ever answered in its own thread
      const again = (await failed())!;
      expect(quota.answer("another-thread", again.card!.requestId!, "answer", "Codex")).toBeNull();
    });

    it("still answers a card raised before a restart", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      // a new process: nothing in memory, the card and its offer on disk
      quota = createQuotaSwitch(deps);
      await answer(card, "Codex");
      expect(thread().modelSelection.instanceId).toBe("codex");
      expect(resend).toHaveBeenCalledTimes(1);
    });

    it("writes nothing into a conversation whose bot was deleted before the switch could land", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      const threadId = bot.threadId;
      const taken = quota.answer(threadId, card.card!.requestId!, "answer", "Codex");
      store.deleteBot(bot.id);
      expect(await taken).toBe("unavailable");
      expect(resend).not.toHaveBeenCalled();
      expect(store.messagesFor(threadId)).toEqual([]);
    });

    it("closes a card answered after it was switched off, and switches nothing", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      enabled = false;
      await answer(card, "Codex");
      expect(thread().modelSelection.instanceId).toBe("claude");
      expect(resend).not.toHaveBeenCalled();
      expect(notices()).toContainEqual({ name: "notice: continuing on another engine is switched off — nothing switched.", ok: false });
      expect(cardNow(card)).toMatchObject({ answered: "unavailable", dismissed: true });
    });
  });

  describe("a conversation that went on without it", () => {
    it("closes the pending card when a later turn of the thread succeeds, so a stale offer resends nothing", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      // the person changed the model by hand and sent the message again
      quota.turnSucceeded(thread(), bot.threadId);

      expect(cardNow(card)).toMatchObject({ answered: "unavailable", dismissed: true });
      expect(quota.answer(bot.threadId, card.card!.requestId!, "answer", "Codex")).toBeNull();
      expect(resend).not.toHaveBeenCalled();
      // and the next limit raises a fresh one
      expect(await failed()).toBeTruthy();
    });

    it("leaves another thread's pending card alone", async () => {
      const card = (await failed())!;
      const otherThread = store.createTask(bot.id, undefined, false)!.threadId;
      quota.turnSucceeded(store.projectBotForTask(bot.id, otherThread)!, otherThread);
      expect(pending()?.id).toBe(card.id);
    });

    it("never fails the turn that worked when the stale card cannot be closed", async () => {
      const card = (await failed())!;
      vi.spyOn(store, "patchMessage").mockImplementationOnce(() => { throw new Error("SQLITE_BUSY: database is locked"); });
      expect(() => quota.turnSucceeded(thread(), bot.threadId)).not.toThrow();
      // the card is still there to close on the next turn that works
      expect(pending()?.id).toBe(card.id);
      quota.turnSucceeded(thread(), bot.threadId);
      expect(pending()).toBeUndefined();
    });
  });
});
