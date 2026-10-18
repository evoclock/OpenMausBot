import { describe, expect, it } from "vitest";
import {
  MuseCodeDriver, museApprovalMode, museCatalog, museChoice, museModelLabel, museQuestions, museServeArgs,
  museToolOutput, museToolStart,
} from "./muse-code.ts";

const choices = [
  { choiceId: "c-once", label: "Allow once", decision: "approved", scope: "once" },
  { choiceId: "c-session", label: "Allow for this session", decision: "approvedForSession", scope: "session" },
  { choiceId: "c-abort", label: "Reject", decision: "abort", scope: "once" },
];

describe("Muse Code driver", () => {
  it("installs with Meta's installer, signs in with `muse login`, and starts on Muse Wonder", () => {
    expect(MuseCodeDriver.install?.command?.darwin).toBe("curl -fsSL https://dev.meta.ai/install.sh | bash");
    expect(MuseCodeDriver.install?.signInCommand).toBe("muse login");
    expect(MuseCodeDriver.defaultConfig()).toEqual({ cli: "muse" });
    expect(MuseCodeDriver.models.default).toBe("muse-wonder-1.0");
  });

  it("builds the picker from the account's own model list", () => {
    // Muse Code 1.4.9 without a sessionId: isActive marks a session's model, so it is false on every row.
    const listed = museCatalog({ models: [
      { modelId: "muse-wonder-1.0", displayLabel: "muse-wonder-1.0", isDefault: true, isActive: false, contextLimit: null },
      { modelId: "muse-wonder-full-1.0", displayLabel: "muse-wonder-full-1.0", isDefault: false, isActive: false },
      { modelId: "muse-spark-1.3", displayLabel: "Muse Spark 1.3", isActive: false, contextLimit: 500_000 },
      { modelId: "muse-spark-1.3" }, { modelId: 7 }, null,
    ] });
    expect(listed).toEqual({ default: "muse-wonder-1.0", options: [
      { id: "muse-wonder-1.0", label: "Muse Wonder 1.0", contextWindow: 1_048_576 },
      { id: "muse-wonder-full-1.0", label: "Muse Wonder Full 1.0", contextWindow: 1_048_576 },
      { id: "muse-spark-1.3", label: "Muse Spark 1.3", contextWindow: 500_000 },
    ] });
    expect(museCatalog({ models: [{ modelId: "muse-spark-1.3" }] }, "muse-next")?.default).toBe("muse-next");
    expect(museCatalog({ models: [] })).toBeNull();
    expect(museCatalog(null)).toBeNull();
    expect(museModelLabel("muse-spark-1.3-contributor")).toBe("Muse Spark 1.3 Contributor");
  });

  it("runs Full without asking or sandbox, and lets Muse ask on every other level", () => {
    expect(museApprovalMode("full")).toBe("allowAll");
    expect(museServeArgs("full")).toEqual(["serve", "--trust-workspace", "--disable-sandbox"]);
    for (const mode of ["ask", "auto", undefined] as const) {
      expect(museApprovalMode(mode)).toBe("promptUnmatched");
      expect(museServeArgs(mode)).toEqual(["serve", "--trust-workspace"]);
    }
  });

  it("answers an approval with the narrowest matching native choice", () => {
    expect(museChoice(choices, "allow")?.choiceId).toBe("c-once");
    expect(museChoice(choices, "allow", true)?.choiceId).toBe("c-session");
    // A shell ask offers no deny, only Reject.
    expect(museChoice(choices, "deny")?.choiceId).toBe("c-abort");
    expect(museChoice([...choices, { choiceId: "c-deny", label: "Deny", decision: "denied", scope: "once" }], "deny")?.choiceId).toBe("c-deny");
    expect(museChoice(choices.slice(2), "allow")).toBeUndefined();
  });

  it("shows a shell call as its command and reports its exit", () => {
    const item = { itemId: "i1", kind: "toolCall", status: "completed", tool: "bash", args: JSON.stringify({ command: "echo hi\nls" }), visibleOutput: "hi", exitCode: 0 };
    expect(museToolStart(item)).toMatchObject({ title: "bash", summary: "echo hi ls" });
    expect(museToolOutput(item)).toEqual({ ok: true, output: "hi" });
    expect(museToolOutput({ ...item, exitCode: 1 })).toMatchObject({ ok: false });
    expect(museToolOutput({ ...item, status: "failed", failureReason: "denied by policy", visibleOutput: undefined }))
      .toEqual({ ok: false, output: "denied by policy" });
    expect(museToolStart({ itemId: "i2", kind: "subagent", status: "inProgress", objective: "Review the diff" }).title).toBe("Review the diff");
  });

  it("turns Muse's questions into card questions keyed by Muse's ids", () => {
    const parsed = museQuestions([
      { id: "q1", header: "City", question: "Which city?", options: [{ label: "Pune" }, { label: "Mumbai" }], selection: { mode: "single" } },
      { id: "q2", header: "Days", question: "Which days?", options: [{ label: "Mon" }, { label: "Tue" }], selection: { mode: "multiple" } },
    ]);
    expect(parsed?.map(({ id, question }) => [id, question.question, question.multiSelect ?? false])).toEqual([
      ["q1", "Which city?", false], ["q2", "Which days?", true],
    ]);
    expect(museQuestions("nope")).toBeNull();
  });
});
