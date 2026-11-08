import { describe, expect, it, vi } from "vitest";
import { withHerdrChildEnvironment } from "./herdr-child-environment.mjs";

const socketPath = "/fixture/home/.config/herdr/herdr.sock";
const home = () => "/fixture/home";

describe("withHerdrChildEnvironment", () => {
  it("sets the default socket and flag when the socket exists without changing the input", () => {
    const env = { OTHER: "kept" };
    const result = withHerdrChildEnvironment(env, { home, exists: (path) => path === socketPath });
    expect(result).toEqual({ OTHER: "kept", HERDR_SOCKET_PATH: socketPath, HERDR_ENV: "1" });
    expect(result).not.toBe(env);
    expect(env).toEqual({ OTHER: "kept" });
  });

  it("does not invent a socket or flag when the default socket is absent", () => {
    const env = { OTHER: "kept" };
    expect(withHerdrChildEnvironment(env, { home, exists: () => false })).toEqual(env);
  });

  it("preserves a supplied path and flag without checking the socket", () => {
    const exists = vi.fn(() => false);
    const result = withHerdrChildEnvironment(
      { HERDR_SOCKET_PATH: "/custom/socket", HERDR_ENV: "custom", OTHER: "kept" },
      { home, exists },
    );
    expect(result).toEqual({ HERDR_SOCKET_PATH: "/custom/socket", HERDR_ENV: "custom", OTHER: "kept" });
    expect(exists).not.toHaveBeenCalled();
  });

  it.each([undefined, ""])("sets the flag for a supplied path when the flag is %s", (flag) => {
    const env = { HERDR_SOCKET_PATH: "/custom/socket", OTHER: "kept" };
    if (flag !== undefined) env.HERDR_ENV = flag;
    expect(withHerdrChildEnvironment(env, { home, exists: () => false })).toEqual({
      HERDR_SOCKET_PATH: "/custom/socket", HERDR_ENV: "1", OTHER: "kept",
    });
  });
});
