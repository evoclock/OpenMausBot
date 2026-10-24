import { describe, expect, it } from "vitest";
import { allowedCodingRecovery, codingRecoveryAllowlist, codingModelChain, codingRecoveryCandidates, recoveryCapabilityError } from "./automatic-recovery.ts";

describe("automatic recovery capabilities", () => {
  it("orders subscription, preferred local, then allowlisted locals and excludes API and unlisted loaded models", () => {
    const instance = (instanceId: string, access: "api" | "custom", models: string[]) => ({
      instanceId, driverKind: "piAgent", enabled: true, access,
      models: { options: models.map((id) => ({ id })) },
    });
    expect(codingModelChain([
      instance("pi", "custom", ["local-2/other", "merge-gateway/paid", "dsf41/deepseek-v4.1-flash-tf", "openai-codex/gpt-6-luna"]),
      instance("billed", "api", ["dsf41/deepseek-v4.1-flash-tf", "openai-codex/gpt-6-luna"]),
    ], ["dsf41", "local-2", "merge-gateway"])).toEqual([
      { instanceId: "pi", model: "openai-codex/gpt-6-luna", modelAccess: "subscription" },
      { instanceId: "pi", model: "dsf41/deepseek-v4.1-flash-tf", modelAccess: "local" },
      { instanceId: "pi", model: "local-2/other", modelAccess: "local" },
    ]);
    expect(codingModelChain([instance("pi", "custom", ["unknown/loaded", "merge-gateway/paid"])], ["dsf41"]))
      .toEqual([]);
    expect(codingModelChain([instance("pi", "custom", ["unknown/loaded", "dsf41/deepseek-v4.1-flash-tf"])], ["dsf41"]))
      .toEqual([{ instanceId: "pi", model: "dsf41/deepseek-v4.1-flash-tf", modelAccess: "local" }]);
  });
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
  it("never uses ordinary API recovery when coding has no permitted fallback", () => {
    const paid = { instanceId: "paid", model: "merge-gateway/paid" };
    expect(codingRecoveryCandidates([], true, [paid], paid)).toEqual([]);
    expect(codingRecoveryCandidates(undefined, true, [paid], paid)).toEqual([paid]);
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
