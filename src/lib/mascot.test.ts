import { describe, expect, it } from "vitest";

import { stateForBot } from "./mascot";

describe("stateForBot", () => {
  it("still alerts on a failed tool call when a digest receipt follows it", () => {
    expect(stateForBot({
      name: "Atlas",
      messages: [
        { kind: "activity", tool: { ok: false } },
        { kind: "digest" },
      ],
    })).toBe("alerting");
  });

  it("keeps reading a pending card as curious behind a receipt", () => {
    expect(stateForBot({ name: "Atlas", messages: [{ kind: "options" }, { kind: "digest" }] })).toBe("curious");
  });

  it("still alerts on a failed tool call when a live call's record follows it", () => {
    expect(stateForBot({
      name: "Atlas",
      messages: [
        { kind: "activity", tool: { ok: false } },
        { kind: "call" },
      ],
    })).toBe("alerting");
    expect(stateForBot({
      name: "Atlas",
      messages: [
        { kind: "activity", tool: { ok: false } },
        { kind: "digest" },
        { kind: "call" },
      ],
    })).toBe("alerting");
  });

  it("keeps reading a pending card as curious behind a live call's record", () => {
    expect(stateForBot({ name: "Atlas", messages: [{ kind: "options" }, { kind: "call" }] })).toBe("curious");
  });
});
