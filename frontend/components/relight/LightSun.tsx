import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, useEffect, useEffectEvent, useState } from "react";
import { SunIcon } from "@/components/icons";
import { cn } from "@/lib/cn";
import { between, clamp, cssColor, heightShare } from "@/lib/lightValues";
import type { FillLight } from "@/lib/types";

/** How close the middle of the sun may come to the stage's left and right edges, in pixels: close enough to reach past a photo that fills the stage, far enough that most of the sun stays in view. Also read by .light-handle in globals.css. */
export const HANDLE_MARGIN_PX = 18;
/**
 * On a touch screen, how far the middle of the sun keeps from the left and right
 * sides of the screen, in pixels. A phone's browser takes a finger that goes down
 * at the very side of the screen as its Back or Forward swipe, and a page cannot
 * switch that off. With the stage 17 px from the side, a sun parked at the stage's
 * edge sat inside that strip: a tester who reached for it on an iPhone left the page.
 */
export const TOUCH_EDGE_CLEAR_PX = 48;
/**
 * How close the middle of the sun may come to the stage's top and bottom, in
 * pixels: the whole strip above and below the photo that holds the stage's
 * buttons ([--stage-inset-y:4rem] on the stage). A sun parked in a strip lay
 * over Export PNG or New photo, and a press on the button picked up the sun:
 * on a phone, where the stage is only as tall as the photo and the buttons
 * fill most of the strip, that was the only place below the photo it could go.
 * Also read by .light-handle in globals.css.
 */
export const HANDLE_MARGIN_Y_PX = 64;

/** The page's two lights: the key, which is the light it always had, and the fill. */
export type Which = "key" | "fill";

/**
 * The sun shows its height, so that the light's distance can be read off the
 * photo with no words: a light near the surface is a small disc with a tight
 * glow and its shadow right under it; pulled toward the viewer it grows, its
 * glow spreads and its shadow falls away below it. Each number is the value at
 * the lowest and at the highest Height; between them it follows the share of
 * the way up in equal ratios (heightShare), because 0.03 to 0.06 changes the
 * picture as much as 1 to 2 does.
 *
 * The disc is 40 px at the Height a new photo starts with (0.12, a third of
 * the way up): 0.64 and 1.72 of that are far enough apart to tell at a glance,
 * while the small one is still easy to see and the large one hides little of
 * the photo. The button itself never goes under 40 px, so it stays easy to grab.
 */
const HANDLE_PX = 40;
const SUN_SCALE = [0.64, 1.72];
/** How far the glow reaches past the disc, and how soft its edge is, in pixels. 24 and 12 at the starting Height, as before the sun showed its height. */
const SUN_GLOW_REACH_PX = [8, 56];
const SUN_GLOW_BLUR_PX = [4, 28];
/** The shadow under the disc: how far below it falls, how soft it is, and how dark. About 3 px, 11 px and 0.7 at the starting Height, much as before. */
const SUN_SHADOW_DROP_PX = [0, 30];
const SUN_SHADOW_BLUR_PX = [4, 24];
const SUN_SHADOW_ALPHA = [0.8, 0.6];

/** The most one scroll event may count for, in pixels: a wheel that speeds up when spun must not jump the light from one end to the other. */
const WHEEL_MAX_STEP_PX = 150;
/** A browser that counts in lines, not pixels (Firefox with a mouse): what one line is worth, so that a notch of three lines matches a notch elsewhere. */
const WHEEL_LINE_PX = 33;
/** A trackpad pinch arrives as a scroll with Ctrl held and much smaller numbers: this many times more is made of each. */
const WHEEL_PINCH_GAIN = 8;
/** Shown under the sun while the mouse rests on it. */
const SUN_HINT = "Scroll to bring the light nearer or push it back";

/** How close the middle of the sun may come to the stage's left and right edges: HANDLE_MARGIN_PX, or more on a touch screen where the stage reaches the side of the screen (TOUCH_EDGE_CLEAR_PX). */
export function handleMarginX(bounds: DOMRect | undefined) {
  if (!bounds || !window.matchMedia("(pointer: coarse)").matches) return HANDLE_MARGIN_PX;
  const gap = Math.min(bounds.left, document.documentElement.clientWidth - bounds.right);
  return Math.max(HANDLE_MARGIN_PX, TOUCH_EDGE_CLEAR_PX - gap);
}

/** One light's sun on the photo: the key's, and beside it the fill's while the fill light is on. */
export function LightSun({
  which,
  light,
  letter,
  onTop,
  dragging,
  name,
  photoRatio,
  marginX,
  onScroll,
  onKeyDown,
}: {
  /** The light it stands for. The stage reads this off the sun that was pressed. */
  which: Which;
  /** Where that light is, how high, how strong and what colour. */
  light: FillLight;
  /** A small letter on the disc, K or F, while there are two suns to tell apart. Null while the key's is the only one, which then looks exactly as it did before there was a fill light. */
  letter: string | null;
  /** Drawn above the other sun: the light the LIGHT panel is on, so it is the one a press reaches where the two overlap. */
  onTop: boolean;
  dragging: boolean;
  /** For a screen reader, ahead of the numbers. */
  name: string;
  /** The photo's width over its height. */
  photoRatio: number;
  /** How close the drawn sun may come to the stage's sides (handleMarginX). */
  marginX: number;
  /** The wheel was turned over this sun, by this many pixels of scroll. */
  onScroll: (step: number) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  // The sun, once it is on the page: scrolling over it needs a listener of its own (below).
  const [handle, setHandle] = useState<HTMLButtonElement | null>(null);
  const scrolled = useEffectEvent(onScroll);

  /**
   * Scrolling while the pointer is over the sun moves the light toward the
   * viewer or away. Only over the sun: anywhere else the wheel scrolls the page
   * as it always did. Scrolling up (or spreading two fingers on a trackpad)
   * brings the light nearer and the sun grows, the way the same gesture zooms
   * in on a map. A Sweep in progress carries on at the new Height.
   * Listened for directly: React's own wheel listener may not stop the page from scrolling.
   */
  useEffect(() => {
    if (!handle) return;
    const onWheel = (event: WheelEvent) => {
      // Over the sun the wheel is the light's, at the ends of the range too: the page must not start to scroll when the light stops.
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? 1 : WHEEL_LINE_PX;
      const step = clamp(event.deltaY * unit * (event.ctrlKey ? WHEEL_PINCH_GAIN : 1), -WHEEL_MAX_STEP_PX, WHEEL_MAX_STEP_PX);
      if (step !== 0) scrolled(step);
    };
    handle.addEventListener("wheel", onWheel, { passive: false });
    return () => handle.removeEventListener("wheel", onWheel);
  }, [handle]);

  // How the sun is drawn at this Height (see SUN_SCALE).
  const lift = heightShare(light.height);
  const sunPx = HANDLE_PX * between(SUN_SCALE, lift);
  const glowReachPx = between(SUN_GLOW_REACH_PX, lift);
  // The shadow stays under the disc until the light is well off the surface, then falls away quickly.
  const sunShadow = `0 ${between(SUN_SHADOW_DROP_PX, lift * lift).toFixed(1)}px ${between(SUN_SHADOW_BLUR_PX, lift).toFixed(1)}px rgb(0 0 0 / ${between(SUN_SHADOW_ALPHA, lift).toFixed(2)})`;
  // The fill's sun is a ring in the fill's colour with the photo showing through it, where the key's is a full disc: the two are told apart before either letter is read.
  const hollow = which === "fill";
  return (
    <button
      ref={setHandle}
      type="button"
      aria-label={`${name}, x ${light.x.toFixed(2)}, y ${light.y.toFixed(2)}, height ${light.height.toFixed(2)}. Use the arrow keys to move, and plus or minus to bring the light nearer or push it back.`}
      data-light={which}
      data-height={light.height.toFixed(2)}
      onKeyDown={onKeyDown}
      className={cn(
        `light-handle group absolute ${onTop ? "z-10" : "z-9"} -translate-x-1/2 -translate-y-1/2 rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/80`,
        dragging ? "cursor-grabbing" : "cursor-grab",
      )}
      style={
        {
          // As large as the disc, and never smaller than the 40 px that is easy to grab.
          width: Math.max(HANDLE_PX, sunPx),
          height: Math.max(HANDLE_PX, sunPx),
          "--light-x": light.x,
          "--light-y": light.y,
          "--photo-ratio": photoRatio,
          "--handle-margin": `${HANDLE_MARGIN_PX}px`,
          "--handle-margin-x": `${marginX}px`,
          "--handle-margin-y": `${HANDLE_MARGIN_Y_PX}px`,
        } as CSSProperties
      }
    >
      <span
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          width: sunPx + 2 * glowReachPx,
          height: sunPx + 2 * glowReachPx,
          filter: `blur(${between(SUN_GLOW_BLUR_PX, lift).toFixed(1)}px)`,
          background: `radial-gradient(circle, ${cssColor(light.color)} 0%, transparent 65%)`,
          opacity: 0.25 + 0.15 * Math.min(light.intensity, 3),
        }}
      />
      <span
        data-sun
        className={cn(
          "pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2",
          hollow ? "bg-black/25" : "border-white text-black/75",
          "transition-[scale,width,height,box-shadow] motion-reduce:transition-none",
          dragging && "scale-110",
        )}
        style={
          hollow
            ? // A dark hairline on each side of the ring keeps a pale ring in sight on a pale part of the photo.
              { width: sunPx, height: sunPx, boxShadow: `${sunShadow}, 0 0 0 1px rgb(0 0 0 / 0.6), inset 0 0 0 1px rgb(0 0 0 / 0.6)`, borderColor: cssColor(light.color) }
            : { width: sunPx, height: sunPx, boxShadow: sunShadow, background: cssColor(light.color) }
        }
      >
        {/* Marked important: the icon's own default size is set the same way, and which class wins otherwise is down to the stylesheet's order. */}
        {!hollow && <SunIcon className="h-1/2! w-1/2!" />}
        {/* On the disc's rim, lower right, whatever its size: 85.4% is the middle plus cos 45 degrees of the radius. */}
        {letter && (
          <span data-letter className="absolute left-[85.4%] top-[85.4%] flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/85 text-[10px] font-bold leading-none text-white ring-1 ring-white/70">
            {letter}
          </span>
        )}
      </span>
      {/* Appears when the mouse has rested on the sun for a moment, and never while it is being dragged. Not on a touch screen: there is no wheel to scroll, and a tap would leave it showing. */}
      {!dragging && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/70 px-2 py-0.5 text-[11px] font-medium text-zinc-200 opacity-0 backdrop-blur transition-opacity delay-0 group-hover:opacity-100 group-hover:delay-500 group-focus-visible:opacity-100 pointer-coarse:hidden"
        >
          {SUN_HINT}
        </span>
      )}
    </button>
  );
}
