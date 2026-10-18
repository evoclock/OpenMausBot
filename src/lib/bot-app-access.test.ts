import { describe, expect, it } from "vitest";

import { botAppScope, withBotApp } from "./bot-app-access";

describe("what one bot may do with a connected app", () => {
  it("is everything while nobody has scoped the bot", () => {
    expect(botAppScope({}, "gmail")).toBe("write");
    expect(botAppScope({ composio: true }, "slack")).toBe("write");
  });

  it("is off for every app while the bot's connected apps are off", () => {
    expect(botAppScope({ composio: false }, "gmail")).toBeNull();
    expect(botAppScope({ composio: false, connectorScopes: { apps: { gmail: "write" } } }, "gmail")).toBeNull();
  });

  it("reads a scoped bot's list: listed apps keep their scope, the rest are off", () => {
    const bot = { connectorScopes: { apps: { gmail: "read" as const, slack: "write" as const } } };
    expect(botAppScope(bot, "gmail")).toBe("read");
    expect(botAppScope(bot, "slack")).toBe("write");
    expect(botAppScope(bot, "github")).toBeNull();
  });
});

describe("switching one app on or off for a bot", () => {
  const connected = ["gmail", "slack", "github"];

  it("turns every-app into a list of the others when the first app goes off", () => {
    expect(withBotApp(undefined, connected, "github", false)).toEqual({ apps: { gmail: "write", slack: "write" } });
  });

  it("changes nothing when the switch already says so", () => {
    expect(withBotApp(undefined, connected, "gmail", true)).toBeUndefined();
    expect(withBotApp({ apps: { gmail: "write" } }, connected, "gmail", true)).toBeUndefined();
    expect(withBotApp({ apps: { gmail: "write" } }, connected, "slack", false)).toBeUndefined();
  });

  it("adds and removes one app on a scoped bot without touching the others", () => {
    const scoped = { apps: { gmail: "read" as const } };
    expect(withBotApp(scoped, connected, "slack", true)).toEqual({ apps: { gmail: "read", slack: "write" } });
    expect(withBotApp({ apps: { gmail: "read", slack: "write" } }, connected, "slack", false)).toEqual({ apps: { gmail: "read" } });
    expect(scoped).toEqual({ apps: { gmail: "read" } });
  });

  it("keeps a list a list: the last app off leaves an empty list, not every app", () => {
    expect(withBotApp({ apps: { gmail: "write" } }, connected, "gmail", false)).toEqual({ apps: {} });
  });

  it("keeps a read-only app read-only when it is already on", () => {
    expect(withBotApp({ apps: { gmail: "read" } }, connected, "gmail", true)).toBeUndefined();
  });
});
