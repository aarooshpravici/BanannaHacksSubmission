/** Sweep: the light's trip once round the subject, as plain numbers. The page runs it frame by frame. */

import { clamp } from "./lightValues";

/** Sweep: how long the light takes to travel once around the subject. Long enough to read, short enough for a demo clip. */
export const SWEEP_MS = 6000;
/** Sweep: the orbit's centre and radius, in photo widths/heights. 0.5 around the middle runs the light along the photo's edges, where side lighting is strongest. */
export const SWEEP_CENTRE = { x: 0.5, y: 0.5 };
export const SWEEP_RADIUS = 0.5;
/** Sweep: the share of the loop spent gliding from the user's light onto the orbit, and again back to it, so nothing jumps. */
export const SWEEP_BLEND = 0.15;
/** Sweep: the share of the time spent speeding up at the start, and again slowing down at the end. Between the two the sun keeps one steady speed. */
export const SWEEP_RAMP = 0.08;
/** Sweep: how many pieces the loop is measured in, so that the sun can be moved along it by distance. */
export const SWEEP_STEPS = 360;

const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Sweep: the light a share `s` (0 to 1) of the way round its loop from `from`: out onto the orbit, once round, and back. */
export function sweepPoint(from: { x: number; y: number }, s: number) {
  const angle = Math.atan2(from.y - SWEEP_CENTRE.y, from.x - SWEEP_CENTRE.x) + s * 2 * Math.PI;
  // 0 at both ends (the user's own position), 1 while on the orbit.
  const onOrbit = smoothstep(clamp(Math.min(s, 1 - s) / SWEEP_BLEND, 0, 1));
  return {
    x: from.x + (SWEEP_CENTRE.x + SWEEP_RADIUS * Math.cos(angle) - from.x) * onOrbit,
    y: from.y + (SWEEP_CENTRE.y + SWEEP_RADIUS * Math.sin(angle) - from.y) * onOrbit,
  };
}

/**
 * Sweep: the loop as points, with the distance travelled to each as it is seen
 * on screen (`aspect` is the photo's width over its height). Turning the angle
 * evenly made the glide on and off the orbit almost twice as fast as the orbit
 * itself, which a tester saw as a sweep that slows down in the middle.
 */
export function sweepLoop(from: { x: number; y: number }, aspect: number) {
  const points = Array.from({ length: SWEEP_STEPS + 1 }, (_, i) => sweepPoint(from, i / SWEEP_STEPS));
  const travelled = [0];
  for (let i = 1; i < points.length; i++) {
    travelled.push(travelled[i - 1] + Math.hypot((points[i].x - points[i - 1].x) * aspect, points[i].y - points[i - 1].y));
  }
  return { points, travelled };
}

/** Sweep: the share of the distance covered after a share `t` of the time. One steady speed, with a short ramp up and down so the sun neither jumps off nor stops dead. */
export function sweepProgress(t: number) {
  const cruise = 1 / (1 - SWEEP_RAMP);
  if (t < SWEEP_RAMP) return (cruise * t * t) / (2 * SWEEP_RAMP);
  if (t > 1 - SWEEP_RAMP) return 1 - (cruise * (1 - t) * (1 - t)) / (2 * SWEEP_RAMP);
  return cruise * (t - SWEEP_RAMP / 2);
}
