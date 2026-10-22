import { describe, expect, it } from "vitest";
import { allowedCodingRecovery, codingRecoveryAllowlist, recoveryCapabilityError } from "./automatic-recovery.ts";

describe("automatic recovery capabilities", () => {
  const engine = { driverKind: "qwenAgent", capabilities: {
    sessionModelSwitch: "unsupported" as const, agentsMcp: true, browserMcp: true,
    customMcp: true, dataMcp: true, highlevelMcp: true, images: true,
  } };
  it("keeps a compatible local workspace and rejects losing a tool or attachment", () => {
    expect(recoveryCapabilityError(engine, { ...engine, driverKind: "claudeAgent" })).toBeUndefined();
    for (const key of ["agentsMcp", "browserMcp", "customMcp", "dataMcp", "highlevelMcp", "images"] as const) {
      expect(recoveryCapabilityError(engine, { ...engine, capabilities: { ...engine.capabilities, [key]: false } })).toMatch(/tools and attachments/);
    }
  });
  it("does not silently move work to a file-less engine", () => {
    expect(recoveryCapabilityError(engine, { ...engine, driverKind: "openai-compat" })).toMatch(/same workspace/);
  });
  it("rejects unlisted model fallback for coding turns without changing ordinary recovery", () => {
    const candidate = { instanceId: "fixture-2", model: "other-model" };
    expect(allowedCodingRecovery(candidate, undefined)).toBe(true);
    expect(allowedCodingRecovery(candidate, [])).toBe(false);
    expect(allowedCodingRecovery(candidate, [{ instanceId: "fixture-2", model: "first-model" }])).toBe(false);
    expect(allowedCodingRecovery(candidate, [candidate])).toBe(true);
    const codingTitle = `Coding ${"a".repeat(64)}`;
    expect(codingRecoveryAllowlist(codingTitle, undefined)).toEqual([]);
    expect(allowedCodingRecovery(candidate, codingRecoveryAllowlist(codingTitle, undefined))).toBe(false);
    expect(codingRecoveryAllowlist(codingTitle, [candidate])).toEqual([candidate]);
    expect(codingRecoveryAllowlist("Ordinary task", undefined)).toBeUndefined();
  });
});
