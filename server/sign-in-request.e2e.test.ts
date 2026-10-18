// Nothing here reaches a real browser, the user's data or port 8799.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";

const asked = (turn: any): string => JSON.stringify(turn.prompt?.message?.content ?? "");

// The browser stand-in is a shell script; the mount only needs it to exist.
it.skipIf(process.platform === "win32")("asks the person to sign in from a real turn, and runs the bot's next turn when they press Done", async () => {
  const tools = mkdtempSync(join(tmpdir(), "omb-sign-in-e2e-"));
  const binaryPath = join(tools, "agent-browser");
  // Answers the saved-login check the mount makes; every other command succeeds silently.
  writeFileSync(binaryPath, `#!/bin/sh\nif [ "$1" = session ] && [ "$2" = list ]; then printf '{"success":true,"data":{"sessions":[]}}'; fi\nexit 0\n`, { mode: 0o755 });
  const fixture = await launchVerificationServer({}, undefined, undefined, { binaryPath, executablePath: join(tools, "chrome") }, undefined, { scripted: true });
  const url = fixture.info.url;
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const evidence = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const stream = await openSse(`${url}/api/events`);
  try {
    expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Signer" })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser" })).status).toBe(200);
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { turns: [
      { steps: [{ tool: "request_sign_in", arguments: { site: "https://www.example.com/dashboard", reason: "The dashboard is behind a login." } }],
        reply: "I asked you to sign in to example.com; I will continue once you have." },
      { reply: "You are signed in, so I opened the dashboard." },
    ] } }));

    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Check my example.com dashboard.", "--url", url]);
    await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(1);
    const call = evidence()[0].evidence.find((entry: any) => entry.step?.tool === "request_sign_in");
    expect(call.response.result.isError).toBeFalsy();
    expect(call.response.result.content[0].text).toContain("The person was asked to sign in to example.com on your built-in browser. Your turn ends now");

    const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages as any[];
    await expect.poll(async () => (await messages()).some((message) => message.text === "I asked you to sign in to example.com; I will continue once you have."),
      { timeout: 15_000 }).toBe(true);
    const cards = (await messages()).filter((message) => message.kind === "signin");
    expect(cards).toHaveLength(1);
    expect(cards[0].signIn).toMatchObject({ site: "example.com", url: "https://www.example.com/dashboard", place: "browser", reason: "The dashboard is behind a login." });
    // With no page open in the bot's browser, a login saved from the card would fill on the card's site only.
    expect(await api("GET", `/api/bots/${bot.id}/sign-in-cards/${cards[0].id}/save-login?threadId=${bot.threadId}`)).toEqual({ status: 200, body: { site: "example.com" } });
    expect((await api("GET", `/api/bots/${bot.id}/sign-in-cards/${cards[0].id}/save-login?threadId=other`)).status).toBe(404);
    const notices = stream.frames.filter((frame) => frame.kind === "notify" && frame.notification?.kind === "sign-in");
    expect(notices).toHaveLength(1);
    expect(notices[0].notification.title).toBe("Signer needs you to sign in to example.com");
    expect((await runControlOmb(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "20", "--url", url]) as any).status).toBe("needs-user");

    expect(await api("POST", `/api/bots/${bot.id}/sign-in-cards/${cards[0].id}/done`, { threadId: bot.threadId }))
      .toMatchObject({ status: 200, body: { done: true, resumed: true } });
    await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(2);
    expect(asked(evidence()[1])).toContain("the person finished signing in to example.com. Check you are signed in, then continue");
    await expect.poll(async () => (await messages()).some((message) => message.text === "You are signed in, so I opened the dashboard."),
      { timeout: 15_000 }).toBe(true);
    expect((await messages()).find((message) => message.id === cards[0].id)?.signIn).toMatchObject({ done: true, resumed: true });
    expect((await api("GET", `/api/bots/${bot.id}/sign-in-cards/${cards[0].id}/save-login?threadId=${bot.threadId}`))).toMatchObject({ status: 409, body: { error: "this sign-in request was already answered" } });
  } finally {
    stream.close();
    await fixture.close();
    await removeTempDir(tools);
  }
}, 90_000);
