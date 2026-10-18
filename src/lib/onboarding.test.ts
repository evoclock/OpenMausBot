import { describe, expect, it } from "vitest";
import {
  beatWidth,
  beatsFor,
  cloudBeatPossible,
  cloudBeatWanted,
  cloudSignInDue,
  flowDotsShown,
  companyModelCount,
  completionPatch,
  EMPTY_ONBOARDING,
  engineSummary,
  hintSeen,
  hostedMember,
  spotlightsQuiet,
  hintSeenPatch,
  LOCAL_VIEWER,
  nextBeat,
  onboardingCloudOffered,
  ONBOARDING_CLOUD_HINT,
  organisationSignIn,
  previousBeat,
  showWelcome,
  welcomeOnScreen,
  welcomeDue,
  welcomeViewer,
  WELCOME_VERSION,
} from "./onboarding";

const done = { completedAt: "2026-09-09T10:00:00.000Z", version: WELCOME_VERSION, reelSeen: false, hintsSeen: [] };

describe("welcomeDue", () => {
  it("waits for the server before deciding", () => {
    expect(welcomeDue(null, { remoteClient: false, legacyDone: false })).toBe(false);
    expect(welcomeDue(undefined, { remoteClient: false, legacyDone: false })).toBe(false);
  });

  it("shows the tour to a fresh workspace", () => {
    expect(welcomeDue({}, { remoteClient: false, legacyDone: false })).toBe(true);
    expect(welcomeDue({ onboarding: EMPTY_ONBOARDING }, { remoteClient: false, legacyDone: false })).toBe(true);
  });

  it("never shows it to a paired remote client", () => {
    expect(welcomeDue({}, { remoteClient: true, legacyDone: false })).toBe(false);
  });

  it("respects a completion at the current version", () => {
    expect(welcomeDue({ onboarding: done }, { remoteClient: false, legacyDone: false })).toBe(false);
  });

  it("re-shows a flow completed at an older version", () => {
    expect(welcomeDue({ onboarding: { ...done, version: WELCOME_VERSION - 1 } }, { remoteClient: false, legacyDone: false })).toBe(true);
  });

  it("honours the old localStorage gate for one release", () => {
    expect(welcomeDue({}, { remoteClient: false, legacyDone: true })).toBe(false);
    expect(welcomeDue({ onboarding: { ...done, version: 0 } }, { remoteClient: false, legacyDone: true })).toBe(true);
  });

  it("decides who gets the tour on a fresh workspace", () => {
    const fresh = { onboarding: EMPTY_ONBOARDING };
    const cases = [
      { who: "local desktop", options: { remoteClient: false, legacyDone: false, ...LOCAL_VIEWER }, due: true },
      { who: "remote client", options: { remoteClient: true, legacyDone: false, ...LOCAL_VIEWER }, due: false },
      { who: "hosted admin", options: { remoteClient: false, legacyDone: false, hosted: true, canSave: true }, due: true },
      { who: "hosted member", options: { remoteClient: false, legacyDone: false, hosted: true, canSave: false }, due: false },
      { who: "member of a self-hosted server", options: { remoteClient: false, legacyDone: false, hosted: false, canSave: false }, due: false },
      { who: "hosted, scope unknown", options: { remoteClient: false, legacyDone: false, hosted: true }, due: false },
    ];
    for (const { who, options, due } of cases) expect(welcomeDue(fresh, options), who).toBe(due);
  });
});

describe("welcomeViewer", () => {
  it("reads the session defensively", () => {
    expect(welcomeViewer({ kind: "loopback", scopes: ["admin", "client"] })).toEqual({ hosted: false, canSave: true });
    expect(welcomeViewer({ kind: "session", scopes: ["admin", "client"], hosted: true })).toEqual({ hosted: true, canSave: true });
    expect(welcomeViewer({ kind: "session", scopes: ["client"], hosted: true })).toEqual({ hosted: true, canSave: false });
    expect(welcomeViewer({ kind: "session", scopes: ["client"] })).toEqual({ hosted: false, canSave: false });
    expect(welcomeViewer({ kind: "loopback", scopes: ["client"], trust: "service" })).toEqual({ hosted: false, canSave: false });
    expect(welcomeViewer({})).toEqual(LOCAL_VIEWER);
    expect(welcomeViewer(null)).toEqual(LOCAL_VIEWER);
    expect(welcomeViewer({ scopes: ["admin"], hosted: "yes" })).toEqual({ hosted: false, canSave: true });
    expect(welcomeViewer({ kind: "session", scopes: ["admin", "client"], cloudHome: true })).toEqual({ hosted: false, canSave: true, cloudHome: true });
    expect(welcomeViewer({ kind: "session", scopes: ["admin", "client"], cloudHome: "yes" })).toEqual({ hosted: false, canSave: true });
  });

  it("calls only a hosted session without admin scope a hosted member", () => {
    expect(hostedMember({ hosted: true, canSave: false })).toBe(true);
    expect(hostedMember({ hosted: true, canSave: true })).toBe(false);
    expect(hostedMember({ hosted: false, canSave: false })).toBe(false);
    expect(hostedMember(LOCAL_VIEWER)).toBe(false);
    expect(hostedMember(null)).toBe(false);
    expect(spotlightsQuiet(null)).toBe(true);
    expect(spotlightsQuiet({ hosted: true, canSave: false })).toBe(true);
    expect(spotlightsQuiet({ hosted: false, canSave: false })).toBe(false);
    expect(spotlightsQuiet(LOCAL_VIEWER)).toBe(false);
  });
});

describe("first run on an OMB Cloud home", () => {
  const connected = welcomeViewer({ kind: "session", scopes: ["admin", "client"], via: "cookie", cloudHome: true });
  const engine = (id: string, authenticated: boolean | undefined, state = "available") => ({ id, state, authenticated });
  const ready = (instance: ReturnType<typeof engine>) => instance.state === "available" && instance.authenticated !== false;
  const signedOut = [engine("claude", false), engine("codex", false), engine("opencodeGo", undefined, "unavailable")];

  it("routes the connected app to the engine sign-in, not the welcome flow", () => {
    expect(cloudSignInDue(connected, { connected: true, instances: signedOut }, ready)).toBe(true);
    expect(welcomeDue({ onboarding: EMPTY_ONBOARDING }, { remoteClient: false, legacyDone: false, ...connected })).toBe(false);
  });

  it("hands over to the chat once any engine can run", () => {
    for (const signedIn of [engine("claude", true), engine("codex", true), engine("anthropic-key", undefined)]) {
      expect(cloudSignInDue(connected, { connected: true, instances: [...signedOut, signedIn] }, ready)).toBe(false);
    }
  });

  it("waits for the server, and changes nothing anywhere else", () => {
    expect(cloudSignInDue(connected, { connected: false, instances: signedOut }, ready)).toBe(false);
    expect(cloudSignInDue(connected, { connected: true, instances: [] }, ready)).toBe(false);
    expect(cloudSignInDue(null, { connected: true, instances: signedOut }, ready)).toBe(false);
    expect(cloudSignInDue({ ...connected, canSave: false }, { connected: true, instances: signedOut }, ready)).toBe(false);
    for (const viewer of [LOCAL_VIEWER, { hosted: true, canSave: true }, welcomeViewer({ kind: "session", scopes: ["admin", "client"] })]) {
      expect(cloudSignInDue(viewer, { connected: true, instances: signedOut }, ready)).toBe(false);
      expect(welcomeDue({ onboarding: EMPTY_ONBOARDING }, { remoteClient: false, legacyDone: false, ...viewer })).toBe(true);
    }
  });
});

describe("organisation sign-in in the engines beat", () => {
  const bridge = { begin: () => {} };

  it("is offered only by the packaged local desktop", () => {
    expect(organisationSignIn({ organization: bridge }, { hosted: false })).toBe(bridge);
    expect(organisationSignIn(undefined, { hosted: false })).toBeUndefined();
    expect(organisationSignIn({}, { hosted: false })).toBeUndefined();
    expect(organisationSignIn({ organization: bridge, remoteClient: { active: true } }, { hosted: false })).toBeUndefined();
    expect(organisationSignIn({ organization: bridge }, { hosted: true })).toBeUndefined();
    expect(organisationSignIn({ organization: bridge, remoteClient: { active: false } }, { hosted: false })).toBe(bridge);
  });

  it("counts the models the organisation approved", () => {
    expect(companyModelCount(null)).toBe(0);
    expect(companyModelCount({})).toBe(0);
    expect(companyModelCount({ providers: [
      { configured: true, models: ["a", "b"] },
      { configured: false, models: ["c"] },
      { configured: true, models: ["d"] },
    ] })).toBe(3);
  });
});

describe("engineSummary", () => {
  type Row = { id: string; install?: object; managed?: object; ok: boolean };
  const ok = (row: Row) => row.ok;
  const personal = (id: string, ready: boolean): Row => ({ id, install: {}, ok: ready });
  const company = (id: string, ready: boolean): Row => ({ id, managed: { organizationId: "org", organizationName: "Org" }, ok: ready });

  it("counts a signed-in Company engine as ready when nothing personal is", () => {
    const rows = [personal("claude", false), personal("codex", false), company("company.claude", true)];
    const summary = engineSummary(rows, ok, { company: true });
    expect(summary.allReady).toBe(true);
    expect(summary.company).toBe(1);
    expect(summary.ready.map((row) => row.id)).toEqual([]);
    expect(summary.setup.map((row) => row.id)).toEqual(["claude", "codex"]);
  });

  it("does not count a Company engine that cannot run", () => {
    const summary = engineSummary([personal("claude", false), company("company.claude", false)], ok, { company: true });
    expect(summary.company).toBe(0);
    expect(summary.allReady).toBe(false);
  });

  it("counts exactly as before where organisation sign-in is not offered", () => {
    const rows = [personal("claude", true), personal("codex", false), company("company.claude", true)];
    const summary = engineSummary(rows, ok, { company: false });
    expect(summary).toEqual({ ready: [rows[0]], setup: [rows[1]], company: 0, allReady: false });
    expect(engineSummary([personal("claude", true)], ok, { company: false }).allReady).toBe(true);
    expect(engineSummary([], ok, { company: false }).allReady).toBe(false);
  });
});

describe("persistence patches", () => {
  it("stamps completion with the current version", () => {
    expect(completionPatch(new Date("2026-09-09T12:34:56.000Z"))).toEqual({
      onboarding: { completedAt: "2026-09-09T12:34:56.000Z", version: WELCOME_VERSION },
    });
  });

  it("adds a hint once and never writes a no-op", () => {
    expect(hintSeen(undefined, "computer")).toBe(false);
    expect(hintSeenPatch(undefined, "computer")).toEqual({ onboarding: { hintsSeen: ["computer"] } });
    const record = { ...EMPTY_ONBOARDING, hintsSeen: ["computer"] };
    expect(hintSeen(record, "computer")).toBe(true);
    expect(hintSeenPatch(record, "computer")).toBeNull();
    expect(hintSeenPatch(record, "apps")).toEqual({ onboarding: { hintsSeen: ["computer", "apps"] } });
  });
});

describe("beat machine", () => {
  it("lists beats for the desktop app with the reel off", () => {
    expect(beatsFor({ dictation: true, reel: false })).toEqual(["hello", "engines", "permissions", "phone", "bot"]);
  });

  it("drops the permissions beat where there is no microphone to ask for", () => {
    expect(beatsFor({ dictation: false, reel: false })).toEqual(["hello", "engines", "phone", "bot"]);
  });

  it("slots the reel after hello when enabled", () => {
    expect(beatsFor({ dictation: false, reel: true })).toEqual(["hello", "reel", "engines", "phone", "bot"]);
  });

  it("always ends on the bot beat", () => {
    for (const dictation of [true, false]) {
      for (const reel of [true, false]) {
        expect(beatsFor({ dictation, reel }).at(-1)).toBe("bot");
        expect(beatsFor({ dictation, reel, hosted: true }).at(-1)).toBe("bot");
      }
    }
  });

  it("gives a hosted workspace a greeting and the bot, nothing about this computer", () => {
    expect(beatsFor({ dictation: true, reel: true, hosted: true })).toEqual(["hello", "bot"]);
    expect(beatsFor({ dictation: true, reel: true, hosted: false })).toEqual(["hello", "reel", "engines", "permissions", "phone", "bot"]);
  });

  it("puts the import step right after the engines, only when this computer has something to bring in", () => {
    expect(beatsFor({ dictation: true, reel: false, setupImport: true })).toEqual(["hello", "engines", "import", "permissions", "phone", "bot"]);
    expect(beatsFor({ dictation: false, reel: true, setupImport: true })).toEqual(["hello", "reel", "engines", "import", "phone", "bot"]);
    expect(beatsFor({ dictation: true, reel: false, setupImport: false })).toEqual(beatsFor({ dictation: true, reel: false }));
    expect(beatsFor({ dictation: true, reel: true, hosted: true, setupImport: true })).toEqual(["hello", "bot"]);
    expect(nextBeat(beatsFor({ dictation: true, reel: false, setupImport: true }), "engines")).toBe("import");
    expect(flowDotsShown("import")).toBe(true);
    expect(beatWidth("import")).toBeGreaterThan(beatWidth("hello"));
  });

  it("with both, the import step follows the engines and the Cloud step comes just before the first bot", () => {
    expect(beatsFor({ dictation: true, reel: true, setupImport: true, cloud: true }))
      .toEqual(["hello", "reel", "engines", "import", "permissions", "phone", "cloud", "bot"]);
    expect(beatsFor({ dictation: false, reel: false, setupImport: true, cloud: true })).toEqual(["hello", "engines", "import", "phone", "cloud", "bot"]);
    expect(beatsFor({ dictation: true, reel: true, hosted: true, setupImport: true, cloud: true })).toEqual(["hello", "bot"]);
  });

  it("walks forward and back and stops at the ends", () => {
    const beats = beatsFor({ dictation: true, reel: false });
    expect(nextBeat(beats, "hello")).toBe("engines");
    expect(nextBeat(beats, "bot")).toBeNull();
    expect(previousBeat(beats, "engines")).toBe("hello");
    expect(previousBeat(beats, "hello")).toBeNull();
    expect(nextBeat(beats, "reel")).toBeNull();
  });

  it("gives the engines beat the widest card", () => {
    expect(beatWidth("engines")).toBeGreaterThan(beatWidth("hello"));
    expect(beatWidth("bot")).toBeGreaterThan(beatWidth("hello"));
  });

  it("shows one row of dots at a time: the reel's own scene dots replace the flow's", () => {
    expect(flowDotsShown("reel")).toBe(false);
    for (const beat of beatsFor({ dictation: true, reel: true }).filter((id) => id !== "reel")) {
      expect(flowDotsShown(beat)).toBe(true);
    }
  });
});

describe("the welcome's MausBot Cloud beat", () => {
  it("comes after the phone and before the first bot, only when the Cloud can be bought here", () => {
    expect(beatsFor({ dictation: true, reel: true, cloud: true })).toEqual(["hello", "reel", "engines", "permissions", "phone", "cloud", "bot"]);
    expect(beatsFor({ dictation: false, reel: false, cloud: true })).toEqual(["hello", "engines", "phone", "cloud", "bot"]);
    expect(beatsFor({ dictation: true, reel: true, cloud: false })).not.toContain("cloud");
    expect(beatsFor({ dictation: true, reel: true })).not.toContain("cloud");
    expect(beatsFor({ dictation: true, reel: true, hosted: true, cloud: true }), "never to a hosted workspace").toEqual(["hello", "bot"]);
    for (const dictation of [true, false]) for (const reel of [true, false]) expect(beatsFor({ dictation, reel, cloud: true }).at(-1)).toBe("bot");
    const beats = beatsFor({ dictation: false, reel: false, cloud: true });
    expect([nextBeat(beats, "phone"), nextBeat(beats, "cloud"), previousBeat(beats, "bot")]).toEqual(["cloud", "bot", "cloud"]);
    expect(beatWidth("cloud")).toBeGreaterThan(beatWidth("hello")); expect(flowDotsShown("cloud")).toBe(true);
  });

  it("is wanted only on this computer's own page with the Cloud bridge, unbranded, for an account that may buy, with the Admin's offer loaded", () => {
    const here = { bridge: true, branded: false, hosted: false, remote: false };
    expect(cloudBeatPossible(here)).toBe(true);
    expect(cloudBeatWanted({ ...here, mayBuy: true, offer: { plans: [] } })).toBe(true);
    for (const [why, place] of [["no Cloud bridge (not packaged, or a remote page)", { bridge: false }], ["a branded build", { branded: true }],
      ["a hosted workspace", { hosted: true }], ["a remote viewer", { remote: true }]] as const) {
      expect(cloudBeatPossible({ ...here, ...place }), why).toBe(false);
      expect(cloudBeatWanted({ ...here, ...place, mayBuy: true, offer: { plans: [] } }), why).toBe(false);
    }
    for (const [why, extra] of [["an account with a plan, or one that may not buy", { mayBuy: false }], ["the account not known yet", { mayBuy: null }],
      ["no offer from the Admin", { offer: null }], ["the offer still loading", { offer: undefined }]] as const) {
      const input: Parameters<typeof cloudBeatWanted>[0] = { ...here, mayBuy: true, offer: { plans: [] } };
      expect(cloudBeatWanted(Object.assign(input, extra)), why).toBe(false);
    }
  });

  it("is recorded once in the onboarding record, so a later Cloud pitch can tell it was offered", () => {
    expect(ONBOARDING_CLOUD_HINT).toBe("onboarding-cloud-v1");
    expect(onboardingCloudOffered(undefined)).toBe(false);
    expect(onboardingCloudOffered({ ...done, hintsSeen: ["tour-switcher"] })).toBe(false);
    const patch = hintSeenPatch({ ...done, hintsSeen: ["tour-switcher"] }, ONBOARDING_CLOUD_HINT)!;
    expect(patch).toEqual({ onboarding: { hintsSeen: ["tour-switcher", "onboarding-cloud-v1"] } });
    expect(onboardingCloudOffered({ ...done, hintsSeen: patch.onboarding.hintsSeen })).toBe(true);
  });

  it("knows while the welcome is on screen, however often it mounts and unmounts", () => {
    expect(welcomeOnScreen()).toBe(false);
    const first = showWelcome(), second = showWelcome();
    expect(welcomeOnScreen()).toBe(true);
    first(); first();
    expect(welcomeOnScreen(), "a second hide of the same mount changes nothing").toBe(true);
    second();
    expect(welcomeOnScreen()).toBe(false);
  });
});
