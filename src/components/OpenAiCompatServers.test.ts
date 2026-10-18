import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as store from "@/state/store";
import { modelIds, OtherOpenAiCompatServers } from "./OpenAiCompatServers";

const fixture = vi.hoisted(() => ({ counting: false, values: [] as unknown[], index: 0, api: vi.fn(), track: vi.fn() }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      if (!fixture.counting) return react.useState(initial);
      const index = fixture.index++;
      if (!(index in fixture.values)) fixture.values[index] = initial;
      return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
    },
  };
});
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), api: fixture.api }));
vi.mock("@/lib/analytics", () => ({ track: fixture.track }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const instance = (instanceId: string, displayName: string, extra: Record<string, unknown> = {}) => ({
  instanceId, driverKind: "openai-compat", displayName,
  snapshot: { state: "available" }, models: { default: "m", options: [] }, ...extra,
}) as unknown as store.InstanceInfo;

function render(instances: store.InstanceInfo[]) {
  vi.stubGlobal("window", {});
  vi.spyOn(store, "useStore").mockReturnValue({
    state: { ...store.initialState, instances },
    dispatch: vi.fn(),
    flushBotPatches: vi.fn(),
    refreshInstances: vi.fn(),
    refreshModels: vi.fn(),
  });
  return renderToStaticMarkup(createElement(OtherOpenAiCompatServers));
}

describe("other OpenAI-compatible servers", () => {
  it("lists only servers added here, by name and base URL, and opens when there are any", () => {
    const html = render([
      instance("openaiCompat", "Other (OpenAI-compatible)"),
      instance("openai", "OpenAI", { url: "https://api.openai.com/v1" }),
      instance("openai-compat-1", "Zhipu", { url: "https://open.bigmodel.cn/api/paas/v4" }),
    ]);
    expect(html).toMatch(/<details[^>]*open=""/);
    expect(html).toContain("Zhipu");
    expect(html).toContain("https://open.bigmodel.cn/api/paas/v4");
    expect(html).toContain('aria-label="Remove Zhipu"');
    expect(html).not.toContain("api.openai.com");
    expect(html).not.toContain('aria-label="Remove OpenAI"');
  });

  it("stays closed and says so when none are added", () => {
    const html = render([instance("openaiCompat", "Other (OpenAI-compatible)")]);
    expect(html).not.toMatch(/<details[^>]*open=""/);
    expect(html).toContain("No other servers yet.");
  });

  it("reads model IDs separated by commas, CJK commas or spaces", () => {
    expect(modelIds("glm-4.6, glm-5，glm-4.6、qwen3 ")).toEqual(["glm-4.6", "glm-5", "qwen3"]);
    expect(modelIds("  ")).toEqual([]);
  });
});

describe("adding another OpenAI-compatible server", () => {
  const KEY = "sk-ZZtestSECRET0123456789";
  type Props = { children?: ReactNode; servers?: unknown; onChange?: (event: { target: { value: string } }) => void; onClick?: () => void; "aria-label"?: string };
  const nodes = (tree: ReactNode): Array<ReactElement<Props>> =>
    Children.toArray(tree).flatMap((child) => isValidElement<Props>(child) ? [child, ...nodes(child.props.children)] : []);
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  function form() {
    vi.stubGlobal("window", {});
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, instances: [] }, dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
    });
    const added = nodes(OtherOpenAiCompatServers()).find((node) => node.props.servers !== undefined)!;
    fixture.counting = true;
    fixture.index = 0;
    try {
      return nodes((added.type as (props: Props) => ReactNode)(added.props));
    } finally {
      fixture.counting = false;
    }
  }
  async function add() {
    for (const [label, value] of [["Display name", "Ada's lab box"], ["Base URL", "https://ada.example.com/v1"], ["API key", KEY]] as const) {
      form().find((node) => node.props["aria-label"] === label)!.props.onChange!({ target: { value } });
    }
    form().find((node) => node.type === "button" && node.props.children && JSON.stringify(node.props.children).includes("Add server"))!.props.onClick!();
    await flush();
  }

  it.each([
    ["unverified", () => fixture.api.mockResolvedValueOnce({ instances: [] })],
    ["error", () => fixture.api.mockRejectedValueOnce(new store.ApiError(`unreachable https://ada.example.com/v1 ${KEY}`, 502, {}))],
  ])("reports one custom endpoint key save (%s), with no name, address or key", async (result, answer) => {
    fixture.values = [];
    fixture.track.mockReset();
    fixture.api.mockReset();
    answer();
    await add();
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/instances/openai-compat", expect.objectContaining({ method: "POST" }));
    expect(fixture.track.mock.calls).toEqual([["api_key_saved", { provider: "custom_endpoint", via: "settings", result }]]);
    expect(JSON.stringify(fixture.track.mock.calls)).not.toMatch(/ada|example|ZZtest|SECRET/);
  });
});
