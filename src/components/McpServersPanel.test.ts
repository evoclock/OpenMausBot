import { afterEach, describe, expect, it } from "vitest";

import { parseMcpArguments, parseMcpEnvironment, parseMcpHeaders, parseMcpOAuthClient } from "./McpServersPanel";
import { parseMcpResultBudget, withResultBudget } from "./McpResultBudgetField";
import { setLocale, t } from "@/lib/i18n";

afterEach(() => setLocale("en"));

describe("MCP server form", () => {
  it("reads the result size limit: blank is the default, 0 never trims, grouping is fine", () => {
    expect(parseMcpResultBudget("")).toEqual({ ok: true, value: undefined });
    expect(parseMcpResultBudget("  ")).toEqual({ ok: true, value: undefined });
    expect(parseMcpResultBudget("0")).toEqual({ ok: true, value: 0 });
    expect(parseMcpResultBudget("40000")).toEqual({ ok: true, value: 40_000 });
    expect(parseMcpResultBudget("40,000")).toEqual({ ok: true, value: 40_000 });
    expect(parseMcpResultBudget("40 000")).toEqual({ ok: true, value: 40_000 });
    expect(parseMcpResultBudget("40.000")).toEqual({ ok: true, value: 40_000 });
    expect(parseMcpResultBudget("1.234.567")).toEqual({ ok: true, value: 1_234_567 });
    expect(parseMcpResultBudget("40_000")).toEqual({ ok: true, value: 40_000 });
    // a decimal is refused, never read as a number ten times larger
    for (const bad of ["-1", "12.5k", "lots", "3000000", "12.5", "1,5", "1.5", "40,00", "1,234.567", "40,0000", ",000"]) {
      expect(parseMcpResultBudget(bad)).toEqual({ ok: false, error: { key: "mcp.err.resultBudget" } });
    }
    expect(t("mcp.resultBudgetHint")).toContain("8,000");
  });

  it("checks the limit before the rest of the form and adds it last, only when set", () => {
    const body = { ok: true as const, body: { command: "notes-mcp" } };
    expect(withResultBudget("40,000", () => body)).toEqual({ ok: true, body: { command: "notes-mcp", resultBudget: 40_000 } });
    expect(withResultBudget("0", () => body)).toEqual({ ok: true, body: { command: "notes-mcp", resultBudget: 0 } });
    expect(withResultBudget("", () => body)).toEqual(body);
    const nameMissing = { ok: false as const, error: { key: "mcp.err.nameAndCommand" as const } };
    expect(withResultBudget("lots", () => nameMissing)).toEqual({ ok: false, error: { key: "mcp.err.resultBudget" } });
    expect(withResultBudget("40000", () => nameMissing)).toEqual(nameMissing);
  });

  it("uses one explicit argument per line", () => {
    expect(parseMcpArguments("-y\n  @scope/server  \n\n--read-only")).toEqual([
      "-y",
      "@scope/server",
      "--read-only",
    ]);
  });

  it("preserves write-only saved values without putting them back in the form", () => {
    expect(parseMcpEnvironment("TOKEN=\nMODE=read-only", ["TOKEN"])).toEqual({
      ok: true,
      env: { TOKEN: true, MODE: "read-only" },
    });
  });

  it("rejects malformed and duplicate environment names", () => {
    expect(parseMcpEnvironment("NOT A KEY=value")).toEqual({
      ok: false,
      error: { key: "mcp.env.invalidName", params: { key: "NOT A KEY" } },
    });
    expect(parseMcpEnvironment("TOKEN=one\nTOKEN=two")).toEqual({
      ok: false,
      error: { key: "mcp.env.duplicate", params: { key: "TOKEN" } },
    });
  });

  it("reads headers as Name: value lines, keeping saved values behind blanks", () => {
    expect(parseMcpHeaders("Authorization: Bearer abc:def\nX-Org:acme\n\nCookie: ", ["Cookie"])).toEqual({
      ok: true,
      headers: { Authorization: "Bearer abc:def", "X-Org": "acme", Cookie: true },
    });
    expect(parseMcpHeaders("Authorization Bearer x")).toEqual({
      ok: false,
      error: { key: "mcp.headers.useColon", params: { line: "Authorization Bearer x" } },
    });
    expect(parseMcpHeaders("Bad Header: x")).toEqual({
      ok: false,
      error: { key: "mcp.headers.invalidName", params: { key: "Bad Header" } },
    });
    expect(parseMcpHeaders("X-A: 1\nX-A: 2")).toEqual({
      ok: false,
      error: { key: "mcp.headers.duplicate", params: { key: "X-A" } },
    });
  });

  it("sends a sign-in app only with a client id, keeping a saved secret behind a blank", () => {
    const blank = { clientId: "", clientSecret: "", scopes: "", forgetSecret: false };
    expect(parseMcpOAuthClient(blank)).toBeUndefined();
    expect(parseMcpOAuthClient({ ...blank, clientId: "  corp-app ", scopes: "offline_access, api://x/read  " })).toEqual({
      clientId: "corp-app",
      scopes: ["offline_access", "api://x/read"],
    });
    expect(parseMcpOAuthClient({ ...blank, clientId: "corp-app" }, { clientSecretConfigured: true })).toEqual({ clientId: "corp-app", clientSecret: true });
    expect(parseMcpOAuthClient({ ...blank, clientId: "corp-app", forgetSecret: true }, { clientSecretConfigured: true })).toEqual({ clientId: "corp-app" });
    expect(parseMcpOAuthClient({ ...blank, clientId: "corp-app", clientSecret: "new" }, { clientSecretConfigured: true })).toEqual({ clientId: "corp-app", clientSecret: "new" });
  });

  it("retains the offending input while an existing error changes language", () => {
    setLocale("de");
    const result = parseMcpEnvironment("TOKEN_WITHOUT_EQUALS");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected an environment error");

    expect(t(result.error.key, result.error.params)).toContain("TOKEN_WITHOUT_EQUALS");
    setLocale("en");
    expect(t(result.error.key, result.error.params)).toBe('Use KEY=value for “TOKEN_WITHOUT_EQUALS”.');
  });
});
