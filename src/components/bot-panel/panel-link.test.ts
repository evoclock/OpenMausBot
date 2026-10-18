import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BOT_SECTIONS } from "../bot-settings/sections";
import { sectionTarget } from "./page-registry";
import { linkTarget, openBotSettings, usePanelLink, type PanelLink } from "./panel-link";

const link = (extra: Partial<PanelLink> & Pick<PanelLink, "section">): PanelLink => ({ nonce: 1, ...extra });

describe("named links into a bot's settings", () => {
  it("opens settings exactly as toggleSettings did, with or without a bot", () => {
    const dispatch = vi.fn();
    openBotSettings(dispatch, "usage");
    openBotSettings(dispatch, "access", { botId: "atlas", page: "apps" });
    expect(dispatch.mock.calls).toEqual([
      [{ type: "toggleSettings", open: true, section: "usage" }],
      [{ type: "toggleSettings", open: true, section: "access", botId: "atlas" }],
    ]);
    expect(Object.keys(dispatch.mock.calls[0]![0])).not.toContain("botId");
  });

  it("lands the access callers on the page that holds what they are about", () => {
    expect(linkTarget("access", link({ section: "access", page: "apps" }))).toEqual({ tab: "details", page: "apps" });
    expect(linkTarget("access", link({ section: "access", page: "mcp" }))).toEqual({ tab: "settings", page: "mcp" });
    expect(linkTarget("access", link({ section: "access", page: "tools" }))).toEqual({ tab: "settings", page: "tools" });
    expect(linkTarget("access", link({ section: "access", page: "folder" }))).toEqual({ tab: "computer", page: "folder" });
    // A plain Access link (the team map's computer button) still opens the Computer tab, where Works on lives.
    expect(linkTarget("access", link({ section: "access" }))).toEqual({ tab: "computer" });
  });

  it("never applies a link's page to another section, and falls back to the section's own place", () => {
    for (const { id } of BOT_SECTIONS) {
      expect(linkTarget(id, null)).toEqual(sectionTarget(id));
      if (id !== "access") expect(linkTarget(id, link({ section: "access", page: "apps" }))).toEqual(sectionTarget(id));
    }
  });

  it("makes every open a new link, so the same one followed twice is seen twice", () => {
    const seen: PanelLink[] = [];
    const Probe = () => {
      const current = usePanelLink();
      if (current) seen.push(current);
      return null;
    };
    openBotSettings(vi.fn(), "usage");
    renderToStaticMarkup(createElement(Probe));
    openBotSettings(vi.fn(), "usage");
    renderToStaticMarkup(createElement(Probe));
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen.map(({ section }) => section)).toEqual(["usage", "usage"]);
    expect(seen[1]!.nonce).toBeGreaterThan(seen[0]!.nonce);
  });
});
