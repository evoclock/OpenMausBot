import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { SetupDetection, SetupImportResult } from "../../../../shared/setup-import";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useEffect: (effect: EffectCallback) => {
    fixture.effects.push(effect);
  },
}));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track: analytics.track }));
vi.mock("@/state/store", () => ({ api: vi.fn() }));
import { ImportBeat, RESULT_READ_MS } from "./ImportBeat";
import { PrimaryButton, QuietButton } from "./shared";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; onChange?: (checked: boolean) => void; label?: string; disabled?: boolean }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return Children.toArray(value as ReactNode).flatMap((child) => (isValidElement(child) ? nodes(child) : []));
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}

const FOUND: SetupDetection = {
  skills: [{ name: "pdf", source: "claudeCode" }, { name: "review", source: "codex" }],
  tools: [{ name: "notion", source: "cursor" }],
};
const BROUGHT: SetupImportResult = {
  skills: { added: ["pdf", "review"], present: [], skipped: [], filesLeftOut: 0, review: [] },
  tools: { added: ["notion"], present: [], skipped: [] },
};
const props = { onNext: vi.fn(), onSkip: vi.fn(), setMascot: vi.fn(), bump: vi.fn(), onResult: vi.fn(), onBusy: vi.fn() };
const apply = vi.fn();
const importClient = { detect: vi.fn(), apply };

function render(extra: { detection?: SetupDetection; result?: SetupImportResult | null } = {}) {
  fixture.index = 0;
  fixture.effects = [];
  let tree: ReactNode = null;
  function Capture() {
    tree = ImportBeat({ ...props, client: importClient, detection: extra.detection ?? FOUND, result: extra.result ?? null });
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  return {
    html,
    primary: all.find((node) => node.type === PrimaryButton)!,
    skip: all.find((node) => node.type === QuietButton),
    row: (label: string) => all.find((node) => node.props.label === label),
  };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  fixture.values = [];
  for (const mock of [...Object.values(props), apply, analytics.track]) mock.mockReset();
  setLocale("en");
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the import step", () => {
  it("offers one ticked row per kind found, with its count and sources", () => {
    const { html, row } = render();
    expect(html).toContain("Bring them in");
    expect(html).toContain("Skip");
    expect(html).toContain("2 from Claude Code and Codex");
    expect(html).toContain("1 MCP server from Cursor");
    expect(html).toContain("Added switched off.");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).not.toMatch(/About me|CLAUDE\.md|AGENTS\.md|pdf|notion/);
    expect(row("Skills")).toBeDefined();
    const toolsOnly = render({ detection: { skills: [], tools: FOUND.tools } });
    expect(toolsOnly.row("Skills")).toBeUndefined();
    expect(toolsOnly.html.match(/type="checkbox"/g)).toHaveLength(1);
  });

  it("brings in what is ticked, counts it for analytics without names, and moves on after a moment", async () => {
    vi.useFakeTimers();
    apply.mockResolvedValue(BROUGHT);
    render().primary.props.onClick!();
    await flush();
    expect(apply).toHaveBeenCalledWith({ skills: true, tools: true });
    expect(props.onResult).toHaveBeenCalledWith(BROUGHT);
    expect(analytics.track).toHaveBeenCalledWith("setup_import_applied", { skills: 2, tools: 1 });
    expect(props.bump).toHaveBeenCalledWith("success");
    render({ result: BROUGHT });
    for (const effect of fixture.effects) effect();
    expect(props.onNext).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RESULT_READ_MS);
    expect(props.onNext).toHaveBeenCalledOnce();
  });

  it("leaves out an unticked kind, and cannot run with nothing ticked", async () => {
    apply.mockResolvedValue({ tools: BROUGHT.tools });
    render().row("Skills")!.props.onChange!(false);
    render().primary.props.onClick!();
    await flush();
    expect(apply).toHaveBeenCalledWith({ tools: true });
    fixture.values = [];
    render().row("Skills")!.props.onChange!(false);
    render().row("Tools")!.props.onChange!(false);
    const none = render();
    expect(none.primary.props.disabled).toBe(true);
    none.primary.props.onClick!();
    await flush();
    expect(apply).toHaveBeenCalledOnce();
  });

  it("tells the flow it is busy for exactly as long as a run lasts", async () => {
    let settle!: (result: SetupImportResult) => void;
    apply.mockReturnValue(new Promise<SetupImportResult>((resolve) => { settle = resolve; }));
    render().primary.props.onClick!();
    await flush();
    expect(props.onBusy.mock.calls).toEqual([[true]]);
    settle(BROUGHT);
    await flush();
    expect(props.onBusy.mock.calls).toEqual([[true], [false]]);
    fixture.values = [];
    apply.mockRejectedValue(new Error("offline"));
    render().primary.props.onClick!();
    await flush();
    expect(props.onBusy.mock.calls.slice(2)).toEqual([[true], [false]]);
  });

  it("says when bringing in failed and lets the person try again or skip", async () => {
    apply.mockRejectedValue(new Error("offline"));
    render().primary.props.onClick!();
    await flush();
    const { html, primary } = render();
    expect(html).toContain("Couldn&#x27;t bring them in. Try again, or skip.");
    expect(primary.props.disabled).toBe(false);
    expect(props.onResult).not.toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalled();
  });

  it("skips with counts only", () => {
    render().skip!.props.onClick!();
    expect(analytics.track).toHaveBeenCalledWith("setup_import_skipped", { skills: 2, tools: 1 });
    expect(props.onSkip).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  });

  it("shows the one-line result, with notes for what was left out, and Continue", () => {
    const { html, primary, skip } = render({
      result: { ...BROUGHT, skills: { ...BROUGHT.skills!, skipped: [{ name: "lint", reason: "conflict" }] } },
    });
    expect(html).toContain("Added 2 skills and 1 tool.");
    expect(html).toContain("Skipped lint: a different skill with that name is already here.");
    expect(html).not.toContain("type=\"checkbox\"");
    expect(skip).toBeUndefined();
    primary.props.onClick!();
    expect(props.onNext).toHaveBeenCalledOnce();
  });

  it("shows a result where nothing came in, because it failed, without the success mark", () => {
    const failed = render({ result: { skills: { added: [], present: [], skipped: [{ name: "pdf", reason: "failed" }], filesLeftOut: 0, review: [] } } });
    expect(failed.html).toContain("Nothing new was added.");
    expect(failed.html).toContain("Couldn&#x27;t bring in pdf. Try again later from Settings → Replay welcome tour.");
    expect(failed.html).not.toContain("bg-success/15");
    expect(render({ result: BROUGHT }).html).toContain("bg-success/15");
  });

  it("does not move on by itself when it comes back to a result", () => {
    vi.useFakeTimers();
    render({ result: BROUGHT });
    for (const effect of fixture.effects) effect();
    vi.advanceTimersByTime(RESULT_READ_MS * 3);
    expect(props.onNext).not.toHaveBeenCalled();
  });
});
