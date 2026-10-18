import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { calibrateIdentity, identityFile, loadOrCalibrateIdentity, type CalibratedIdentity } from "./calibrate.ts";

const folders: string[] = [];
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });

function folder(): string {
  const made = mkdtempSync(join(tmpdir(), "omb-calibrate-test-"));
  folders.push(made);
  return made;
}

const READ: CalibratedIdentity = {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  userAgentMetadata: {
    brands: [{ brand: "Chromium", version: "153" }], fullVersionList: [{ brand: "Chromium", version: "153.0.8010.47" }], fullVersion: "153.0.8010.47",
    platform: "macOS", platformVersion: "26.3.1", architecture: "arm", model: "", mobile: false, bitness: "64", wow64: false, formFactors: ["Desktop"],
  },
  product: "Chrome/153.0.8010.47",
  fingerprint: "",
  calibratedAt: "2026-10-16T00:00:00.000Z",
};

describe("reading a Chrome's own identity", () => {
  it.skipIf(process.platform === "win32")("starts the binary headless over a pipe, off the keychain, on the account's real home, and says when it exits", async () => {
    const dir = folder();
    const chrome = join(dir, "chrome");
    writeFileSync(chrome, `#!/bin/sh\n{ printf '%s\\n' "$HOME" "$@"; echo ::end::; } >> '${dir}/runs'\nexit 3\n`, { mode: 0o755 });
    await expect(calibrateIdentity({ executablePath: chrome, host: "desktop", env: { PATH: "/usr/bin:/bin", HOME: "/tmp/not-a-home" }, tmpRoot: dir, handshakeTimeoutMs: 10_000 })).rejects.toThrow(/exited|closed its DevTools pipe/);
    const runs = readFileSync(join(dir, "runs"), "utf8").split("::end::\n").filter(Boolean).map((run) => run.split("\n").filter(Boolean));
    expect(runs.map(([home]) => home)).toEqual(runs.map(() => userInfo().homedir));
    const [launch, ...diagnosis] = runs;
    const args = launch!.slice(1);
    expect(args).toContain("--headless=new");
    expect(args).toContain(process.platform === "darwin" ? "--use-mock-keychain" : "--password-store=basic");
    expect(args).toContain("--remote-debugging-pipe");
    expect(args.filter((arg) => arg.startsWith("--remote-debugging-port"))).toEqual([]);
    expect(diagnosis.map((run) => run.slice(1))).toEqual(process.platform === "linux" ? [["--version"]] : []);
  });

  it("reads it once per binary, and again after the binary changed in place", async () => {
    const dir = folder();
    const app = join(dir, "Google Chrome.app", "Contents");
    mkdirSync(join(app, "MacOS"), { recursive: true });
    const chrome = join(app, "MacOS", "Google Chrome");
    writeFileSync(chrome, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(app, "Info.plist"), "<plist>153</plist>");
    const calibrate = vi.fn(async () => ({ ...READ }));
    const options = { executablePath: chrome, host: "desktop" as const };
    expect((await loadOrCalibrateIdentity(dir, options, calibrate)).calibrated).toBe(true);
    expect((await loadOrCalibrateIdentity(dir, options, calibrate)).calibrated).toBe(false);
    expect(calibrate).toHaveBeenCalledOnce();
    const stored = JSON.parse(readFileSync(identityFile(dir, chrome), "utf8")) as CalibratedIdentity;
    expect(stored.product).toBe("Chrome/153.0.8010.47");
    writeFileSync(join(app, "Info.plist"), "<plist>154 with a longer version</plist>");
    expect((await loadOrCalibrateIdentity(dir, options, calibrate)).calibrated).toBe(true);
    expect(calibrate).toHaveBeenCalledTimes(2);
  });
});
