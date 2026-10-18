// The page a bot's browser shows its viewers: the size a setting gives it within the screen, and how a zoom lays it out.
import { fitPage } from "../chrome/flags.ts";

export const UNATTACHED_VIEWPORT = { width: 1280, height: 800 } as const;
export const VIEWPORT_LIMITS = { minWidth: 100, minHeight: 100, maxWidth: 3840, maxHeight: 2160 } as const;
/** Chrome keeps a window at least this wide (measured on 153); a narrower page needs emulation. */
export const MIN_WINDOW_WIDTH = 500;
/** Chrome's own zoom range. */
export const ZOOM_LIMITS = { min: 0.25, max: 5 } as const;

/** The viewport sizes a person can pick: fill follows the panel; a preset letterboxes in it. */
export const VIEWPORT_PRESETS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 390, height: 844 },
} as const;

export type ViewportSetting =
  | { mode: "fill" }
  | { mode: "preset"; preset: keyof typeof VIEWPORT_PRESETS; landscape?: boolean }
  | { mode: "fixed"; width: number; height: number };

/**
 * The CSS size `setting` gives the page, `requested` being the panel size of the viewer that asked last, within `limit`,
 * the largest page the screen fits: a filled panel gets a page of its own shape, which the viewer scales to fill it; a
 * set size is cut to fit.
 */
export function viewportFor(setting: ViewportSetting, requested: { width: number; height: number } | null, limit: { width: number; height: number } | null = null): { width: number; height: number } {
  if (setting.mode === "fill") return fitPage(requested ?? { ...UNATTACHED_VIEWPORT }, limit);
  const size = setting.mode === "fixed" ? { width: setting.width, height: setting.height } : presetSize(setting);
  if (!limit) return size;
  return { width: size.width < MIN_WINDOW_WIDTH ? size.width : Math.min(size.width, limit.width), height: Math.min(size.height, limit.height) };
}

function presetSize(setting: Extract<ViewportSetting, { mode: "preset" }>): { width: number; height: number } {
  const preset = VIEWPORT_PRESETS[setting.preset];
  return setting.landscape ? { width: preset.height, height: preset.width } : { ...preset };
}

/** The CSS size a page of `size` lays out in at `zoom`, as Chrome zooms. */
export const zoomedLayout = (size: { width: number; height: number }, zoom: number) => ({ width: Math.max(1, Math.round(size.width / zoom)), height: Math.max(1, Math.round(size.height / zoom)) });
