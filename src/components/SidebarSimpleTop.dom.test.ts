// @vitest-environment happy-dom
// The Simple sidebar's edge bump in a real DOM: it must end up last in <body>, pinned to the sidebar's edge, because
// Electron applies -webkit-app-region rects in document order and the chat header's drag rect comes after the sidebar.
import { createElement, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SidebarEdgeToggle } from "./SidebarSimpleTop";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function Harness({ onToggle }: { onToggle: () => void }) {
  const aside = useRef<HTMLElement>(null);
  return createElement("aside", { ref: aside, "data-sidebar": "" },
    createElement(SidebarEdgeToggle, { collapsed: false, onToggle, anchorRef: aside, style: { WebkitAppRegion: "no-drag" } as never }));
}

it("moves the bump to the end of <body>, pinned to the sidebar's right edge, after mounting", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { left: 0, top: 0, width: 288, height: 900, right: this.hasAttribute("data-sidebar") ? 288 : 0, bottom: 900, x: 0, y: 0, toJSON() {} } as DOMRect;
  });
  const onToggle = vi.fn();
  flushSync(() => root.render(createElement(Harness, { onToggle })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const bump = document.querySelector<HTMLButtonElement>("[data-sidebar-edge-toggle]")!;
  expect(bump.parentElement).toBe(document.body);
  expect(document.body.lastElementChild).toBe(bump);
  expect(bump.className).toContain("fixed");
  expect(bump.style.left).toBe("288px");
  expect(container.querySelector("[data-sidebar-edge-toggle]")).toBeNull();
  flushSync(() => bump.click());
  expect(onToggle).toHaveBeenCalledOnce();
});
