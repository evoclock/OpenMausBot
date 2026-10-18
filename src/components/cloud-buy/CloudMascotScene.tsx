// MausBot Cloud's night shift: three Maus bots work on a cloud under the moon while this computer sleeps on its hill.
import { memo, useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from "react";
import { MausAvatar } from "@/components/Avatar";
import { t } from "@/lib/i18n";
import type { MausColor, MausState } from "@/lib/mascot";
import { reducedMotion } from "@/lib/onboarding";

type Variant = "hero" | "beat";
type Spot = readonly [x: number, y: number, size: number];
type Area = readonly [width: number, height: number];

const CREW_AREA: Area = [220, 86];
const HOME_WIDTH = 100;
const LAYOUTS: Record<Variant, { area: Area; crew: Spot; home: Spot; moon: Spot }> = {
  hero: { area: [320, 150], crew: [10, 56, 220], home: [210, 92, 104], moon: [278, 30, 13] },
  beat: { area: [400, 116], crew: [40, 28, 204], home: [270, 56, 114], moon: [334, 24, 11] },
};

/** Each bot keeps one calm state, which the mascot animates by itself (its faces, blinks and a slow bob or sway). */
const CREW: readonly { color: MausColor; state: MausState; spot: Spot }[] = [
  { color: "orange", state: "working", spot: [30, 14, 46] },
  { color: "pink", state: "idle", spot: [84, 7, 52] },
  { color: "green", state: "thinking", spot: [144, 14, 46] },
];
const BACK_PUFFS = [[36, 50, 18], [72, 36, 26], [114, 33, 26], [152, 40, 23], [186, 50, 19]] as const;
const FRONT_PUFFS = [[28, 68, 12], [55, 65, 16], [90, 64, 18], [126, 65, 16.5], [158, 66, 15], [190, 68, 12.5]] as const;
/** [x %, y %, radius, seconds per twinkle (0: steady), delay]; sparkles add a tint. */
const STARS = [
  [3, 20, 1.1, 0, 0], [7, 56, 0.8, 0, 0], [11, 8, 1.3, 5.6, -2.6], [21, 46, 0.8, 0, 0], [26, 12, 0.9, 0, 0],
  [33, 4, 1.1, 0, 0], [38, 26, 0.7, 0, 0], [45, 9, 1.2, 6.4, -2], [51, 3, 0.8, 0, 0], [57, 24, 1, 0, 0],
  [62, 8, 0.7, 0, 0], [68, 30, 0.9, 4.8, -1.5], [73, 6, 1.1, 0, 0], [87, 32, 1, 0, 0], [92, 9, 1.2, 0, 0], [97, 44, 0.9, 0, 0],
] as const;
const SPARKLES = [[16, 30, 3.2, 6, -1.4, "#ffc4e4"], [64, 16, 2.6, 7, -2.9, "#b5f2ff"], [95, 24, 2.4, 5.2, -0.6, "#ffe9a8"]] as const;
/** The z bubbles where the still frame shows them; live, the CSS drifts each one up the same path, a third of a loop apart. */
const ZS = [[0, 0, 0.62], [7, -11, 0.85], [16, -23, 1.08]] as const;
const Z = "M-2.4-2.4h4.8l-4.8 4.8h4.8";

const percent = (part: number, whole: number) => `${(part / whole) * 100}%`;
const place = ([x, y, width]: Spot, [areaWidth, areaHeight]: Area, height = width): CSSProperties => ({
  left: percent(x, areaWidth), top: percent(y, areaHeight), width: percent(width, areaWidth), height: percent(height, areaHeight),
});
const twinkle = (live: boolean, seconds: number, delay: number): { className?: string; style?: CSSProperties } =>
  live && seconds ? { className: "cloud-scene-twinkle", style: { animationDuration: `${seconds}s`, animationDelay: `${delay}s` } } : {};
const sparkle = (r: number) => {
  const k = r * 0.18;
  return `M0 ${-r}Q${k} ${-k} ${r} 0Q${k} ${k} 0 ${r}Q${-k} ${k} ${-r} 0Q${-k} ${-k} 0 ${-r}Z`;
};

function subscribeReducedMotion(changed: () => void) {
  const query = globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)");
  query?.addEventListener?.("change", changed);
  const root = globalThis.document?.documentElement;
  const hook = root && typeof MutationObserver === "function" ? new MutationObserver(changed) : null;
  if (root) hook?.observe(root, { attributes: true, attributeFilter: ["data-reduced-motion"] });
  return () => {
    query?.removeEventListener?.("change", changed);
    hook?.disconnect();
  };
}

function useInView(target: RefObject<HTMLElement | null>) {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const node = target.current;
    if (!node || typeof IntersectionObserver !== "function") return;
    const watch = new IntersectionObserver(entries => setInView(entries.at(-1)?.isIntersecting ?? true));
    watch.observe(node);
    return () => watch.disconnect();
  }, [target]);
  return inView;
}

function Laptop({ metal, glass }: { metal: string; glass: string }) {
  return <g transform="translate(46 32)">
    <ellipse cx="4" cy="2.6" rx="29" ry="3.6" fill="#000" opacity=".32" />
    <path d="M-21-1.5 19 1v2.2l-40-2.5Z" fill="#8a92b1" />
    <path d="M19 1 27-6.5v2.2L19 3.2Z" fill="#646c8c" />
    <path d="M-21-1.5 19 1 27-6.5-13-9Z" fill={metal} stroke="#eef0f8" strokeWidth=".7" strokeLinejoin="round" />
    <path d="M-15.4-6.3 15.6-4.4 20.5-8.4-10.6-10.3Z" fill="#4b5272" opacity=".55" transform="translate(.6 2.2)" />
    <path d="M-3.3-.6 5.3-.1 6.9-2.2-1.7-2.7Z" fill="#fff" opacity=".55" />
    <path d="M-13-9 27-6.5 29.2-31.6-10.8-34.1Z" fill="#c9cee0" />
    <path d="M-11.6-10.4 25.6-8.1 27.5-30.1-9.7-32.4Z" fill={glass} />
    <path d="M-2.5-31.8 10.6-31 0-9.5-13.1-10.3Z" fill="#fff" opacity=".07" />
    <circle cx="13.3" cy="2.35" r=".95" fill="#b6f5d2" opacity=".7" />
  </g>;
}

/** The Cloud scene for the buying sheet ("hero") and the welcome's Cloud beat ("beat"). The bots keep their own calm
 * states, a few stars twinkle and the z's drift up. `paused` (something covers it) or out of view holds all of it;
 * reduced motion shows it still. */
export const CloudMascotScene = memo(function CloudMascotScene({ variant, paused = false }: { variant: Variant; paused?: boolean }) {
  const { area, crew, home: [homeX, homeY, homeWidth], moon: [moonX, moonY, moonR] } = LAYOUTS[variant];
  const [areaWidth, areaHeight] = area;
  const uid = `cloud-scene${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const root = useRef<HTMLDivElement>(null);
  const inView = useInView(root);
  const live = !useSyncExternalStore(subscribeReducedMotion, reducedMotion, reducedMotion);
  const moving = live && !paused && inView;
  const url = (name: string) => `url(#${uid}-${name})`;

  return <div ref={root} role="img" aria-label={t("cloudScene.label")} data-cloud-scene={variant} data-paused={moving ? undefined : ""}
    className={`cloud-scene cloud-scene-${variant}`}>
    <svg className="cloud-scene-layer" aria-hidden="true">
      {STARS.map(([x, y, r, seconds, delay]) => <circle key={`${x}-${y}`} cx={`${x}%`} cy={`${y}%`} r={r} fill="var(--cloud-scene-star)"
        opacity={seconds ? undefined : 0.7} {...twinkle(live, seconds, delay)} />)}
      {SPARKLES.map(([x, y, r, seconds, delay, tint]) => <svg key={`${x}-${y}`} x={`${x}%`} y={`${y}%`} overflow="visible">
        <path d={sparkle(r)} fill={tint} {...twinkle(live, seconds, delay)} />
      </svg>)}
    </svg>
    <div className="cloud-scene-stage">
      <svg className="cloud-scene-layer" viewBox={`0 0 ${areaWidth} ${areaHeight}`} aria-hidden="true">
        <defs>
          <radialGradient id={`${uid}-halo`}>
            <stop offset="0" style={{ stopColor: "var(--cloud-scene-moon-glow)" }} />
            <stop offset="1" style={{ stopColor: "var(--cloud-scene-moon-glow)", stopOpacity: 0 }} />
          </radialGradient>
          <linearGradient id={`${uid}-moon`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fff4c9" />
            <stop offset="1" stopColor="#f6c453" />
          </linearGradient>
          <mask id={`${uid}-crescent`}>
            <rect width={areaWidth} height={areaHeight} fill="#fff" />
            <circle cx={moonX + moonR * 0.42} cy={moonY - moonR * 0.34} r={moonR * 0.86} fill="#000" />
          </mask>
          <linearGradient id={`${uid}-lid`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f6f7fc" />
            <stop offset="1" stopColor="#b7bdd6" />
          </linearGradient>
          <linearGradient id={`${uid}-glass`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#262c52" />
            <stop offset="1" stopColor="#0d1024" />
          </linearGradient>
          <linearGradient id={`${uid}-hill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: "var(--cloud-scene-hill-top)" }} />
            <stop offset=".5" style={{ stopColor: "var(--cloud-scene-hill-bottom)" }} />
          </linearGradient>
          <radialGradient id={`${uid}-mist`}>
            <stop offset="0" style={{ stopColor: "var(--cloud-scene-mist)" }} />
            <stop offset="1" style={{ stopColor: "var(--cloud-scene-mist)", stopOpacity: 0 }} />
          </radialGradient>
          <radialGradient id={`${uid}-lamp`}>
            <stop offset="0" style={{ stopColor: "var(--cloud-scene-lamp)", stopOpacity: 0.62 }} />
            <stop offset=".55" style={{ stopColor: "var(--cloud-scene-lamp)", stopOpacity: 0.22 }} />
            <stop offset="1" style={{ stopColor: "var(--cloud-scene-lamp)", stopOpacity: 0 }} />
          </radialGradient>
          <radialGradient id={`${uid}-shadow`}>
            <stop offset="0" style={{ stopColor: "var(--cloud-scene-cloud-shade)", stopOpacity: 0.85 }} />
            <stop offset="1" style={{ stopColor: "var(--cloud-scene-cloud-shade)", stopOpacity: 0 }} />
          </radialGradient>
          <linearGradient id={`${uid}-back`} gradientUnits="userSpaceOnUse" x1="0" y1="4" x2="0" y2="80">
            <stop offset="0" style={{ stopColor: "var(--cloud-scene-cloud-top)" }} />
            <stop offset="1" style={{ stopColor: "var(--cloud-scene-cloud-shade)" }} />
          </linearGradient>
          <linearGradient id={`${uid}-front`} gradientUnits="userSpaceOnUse" x1="0" y1="44" x2="0" y2="82">
            <stop offset="0" stopColor="#fff" />
            <stop offset="1" style={{ stopColor: "var(--cloud-scene-cloud-low)" }} />
          </linearGradient>
        </defs>
        <circle cx={moonX} cy={moonY} r={moonR * 2.7} fill={url("halo")} />
        <circle cx={moonX} cy={moonY} r={moonR} fill={url("moon")} mask={url("crescent")} />
        <g transform={`translate(${homeX} ${homeY}) scale(${homeWidth / HOME_WIDTH})`}>
          <path d="M-14 62C-2 45 16 35 46 34.6S110 37.5 400 45V62Z" fill={url("hill")} />
          <path d="M-14 62C-2 45 16 35 46 34.6S110 37.5 400 45" fill="none" stroke="var(--cloud-scene-rim)" strokeWidth="1" />
          <Laptop metal={url("lid")} glass={url("glass")} />
          <g transform="translate(76 -4)">
            {ZS.map(([x, y, scale]) => <g key={x} className={live ? "cloud-scene-z" : undefined} transform={`translate(${x} ${y}) scale(${scale})`}>
              <circle r="7.5" fill="var(--cloud-scene-bubble)" stroke="var(--cloud-scene-bubble-edge)" strokeWidth="1" />
              <circle cx="-4.3" cy="-4.3" r="1.1" fill="#fff" opacity=".85" />
              <path d={Z} fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </g>)}
          </g>
        </g>
      </svg>
      <div className="cloud-scene-box" style={place(crew, area, (crew[2] * CREW_AREA[1]) / CREW_AREA[0])}>
        <svg className="cloud-scene-layer" viewBox={`0 0 ${CREW_AREA[0]} ${CREW_AREA[1]}`} aria-hidden="true">
          <ellipse cx="110" cy="50" rx="140" ry="62" fill={url("mist")} />
          <g fill={url("back")}>
            <rect x="10" y="44" width="200" height="34" rx="17" />
            {BACK_PUFFS.map(([cx, cy, r]) => <circle key={cx} cx={cx} cy={cy} r={r} />)}
          </g>
          {CREW.map(({ color, spot: [x, y, size] }) => <ellipse key={color} cx={x + size * 0.5} cy={y + size * 0.8} rx={size * 0.5} ry={size * 0.13} fill={url("shadow")} />)}
        </svg>
        {CREW.map(({ color, state, spot }) => <div key={color} className="cloud-scene-box" style={place(spot, CREW_AREA)}>
          <MausAvatar color={color} state={state} size={spot[2]} animated={moving} trackPointer={false} />
        </div>)}
        <svg className="cloud-scene-layer" viewBox={`0 0 ${CREW_AREA[0]} ${CREW_AREA[1]}`} aria-hidden="true">
          <g fill={url("front")}>
            <rect x="15" y="60" width="190" height="20" rx="10" />
            {FRONT_PUFFS.map(([cx, cy, r]) => <circle key={cx} cx={cx} cy={cy} r={r} />)}
          </g>
          {CREW.map(({ color, spot: [x, y, size] }) => <ellipse key={color} cx={x + size * 0.48} cy={y + size * 1.02} rx={size * 0.66} ry={size * 0.17} fill={url("lamp")} />)}
        </svg>
      </div>
    </div>
  </div>;
});
