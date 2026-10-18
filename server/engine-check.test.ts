import { describe, expect, it, vi } from "vitest";
import { checkEngine, engineCheckError } from "./engine-check.ts";

const engine = (generateText?: (prompt: string) => Promise<string>, instanceId = "claude") =>
  ({ instanceId, displayName: "Claude", driverKind: "claudeAgent", generateText: generateText && vi.fn(generateText) });

describe("checking a just-connected engine with one tiny real message", () => {
  it("is working when it answers anything, and sends only the short check prompt", async () => {
    const instance = engine(async () => "OK");
    expect(await checkEngine(instance)).toEqual({ ok: true });
    expect(instance.generateText).toHaveBeenCalledOnce();
    expect(instance.generateText!.mock.calls[0]![0]).toMatch(/connection check.*single word OK/);
  });

  it("names the exact fix: sign in again, the provider's own refusal in plain words, or what it said", async () => {
    expect(await checkEngine(engine(async () => { throw new Error("Not logged in · Please run /login"); })))
      .toEqual({ ok: false, error: "Claude isn't signed in on this computer anymore. Sign in again, then check again." });
    expect((await checkEngine(engine(async () => { throw new Error("API Error: 402 {\"error\":{\"message\":\"Your credit balance is too low\"}}"); }))))
      .toMatchObject({ ok: false, error: expect.stringContaining("Your Claude account is out of credits") });
    expect(await checkEngine(engine(async () => ""))).toEqual({ ok: false, error: "Claude answered with nothing. Check again in a minute." });
    expect(engineCheckError("ChatGPT", "spawn codex ENOENT with key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789")).not.toContain("sk-proj-abcdefghijklmnop");
  });

  it("can't check an engine without a one-shot call, and runs one check per engine at a time", async () => {
    expect(await checkEngine(engine(undefined))).toEqual({ ok: null });
    let answer!: (text: string) => void;
    const instance = engine(() => new Promise<string>(resolve => { answer = resolve; }), "codex");
    const first = checkEngine(instance), second = checkEngine(instance);
    answer("OK");
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    expect(instance.generateText).toHaveBeenCalledOnce();
    const again = checkEngine(instance);
    answer("OK");
    expect(await again).toEqual({ ok: true });
    expect(instance.generateText).toHaveBeenCalledTimes(2);
  });
});
