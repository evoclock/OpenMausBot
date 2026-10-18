import { describe, expect, it } from "vitest";

import { expectedUserAgent } from "./testing/browser-identity-probe.ts";
import { completeHints } from "./verify-browser-identity.ts";

const MAC = {
  architecture: "arm", bitness: "64", brands: [{ brand: "Chromium", version: "153" }], formFactors: ["Desktop"],
  fullVersionList: [{ brand: "Chromium", version: "153.0.8010.47" }], mobile: false, model: "", platform: "macOS",
  platformVersion: "26.3.1", uaFullVersion: "153.0.8010.47", wow64: false,
};

describe("the identity checks", () => {
  it("want every high-entropy hint, where Chrome reports it", () => {
    expect(completeHints(MAC)).toBe(true);
    expect(completeHints({ ...MAC, platformVersion: "" })).toBe(false);
    expect(completeHints({ ...MAC, platform: "Linux", platformVersion: "" })).toBe(true);
    expect(completeHints({ ...MAC, architecture: "", fullVersionList: [] })).toBe(false);
    expect(completeHints(null)).toBe(false);
  });

  it("expect Chrome's reduced user agent for each desktop", () => {
    expect(expectedUserAgent("153", "darwin")).toBe("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36");
    expect(expectedUserAgent("155", "win32")).toBe("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36");
    expect(expectedUserAgent("155", "linux")).toBe("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36");
  });
});
