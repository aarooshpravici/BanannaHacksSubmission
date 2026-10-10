"use client";

import { type PointerEvent as ReactPointerEvent, type RefObject, useRef } from "react";
import { cn } from "@/lib/cn";
import type { BBox } from "@/lib/image";

export type MaskTool = "box" | "brush";

interface MaskCanvasProps {
  /** Image size in pixels; the canvas draws at this resolution. */
  width: number;
  height: number;
  /** null = not drawing: the canvas only shows what was painted and lets clicks through. */
  tool: MaskTool | null;
  /** Brush diameter, in image pixels. */
  brushSize: number;
  /** The drawing canvas: anything painted on it is the mask (see canvasToMask). */
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** A box was dragged out. The canvas now holds exactly that rectangle. */
  onBox: (bbox: BBox) => void;
  /** A brush stroke ended. Strokes accumulate until the canvas is cleared. */
  onStroke: () => void;
  className?: string;
}

const PAINT = "#fbd13d";
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Transparent drawing layer over the design for making a custom mask by hand. */
export function MaskCanvas({ width, height, tool, brushSize, canvasRef, onBox, onStroke, className }: MaskCanvasProps) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const last = useRef<{ x: number; y: number } | null>(null);

  const context = () => canvasRef.current?.getContext("2d") ?? null;

  /** Pointer position in image pixels. */
  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * width, 0, width),
      y: clamp(((event.clientY - rect.top) / rect.height) * height, 0, height),
    };
  };

  const boxFrom = (a: { x: number; y: number }, b: { x: number; y: number }): BBox => {
    const x = Math.round(Math.min(a.x, b.x));
    const y = Math.round(Math.min(a.y, b.y));
    return [x, y, Math.round(Math.max(a.x, b.x)) - x, Math.round(Math.max(a.y, b.y)) - y];
  };

  const stroke = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const ctx = context();
    if (!ctx) return;
    ctx.strokeStyle = PAINT;
    ctx.lineWidth = brushSize;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x + 0.01, to.y); // a zero-length line draws nothing; this makes a dot
    ctx.stroke();
  };

  const drawBox = (bbox: BBox) => {
    const ctx = context();
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = PAINT;
    ctx.fillRect(...bbox);
  };

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className={cn("touch-none opacity-45", tool ? "cursor-crosshair" : "pointer-events-none", className)}
      onPointerDown={(e) => {
        if (!tool || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = point(e);
        start.current = p;
        last.current = p;
        if (tool === "brush") stroke(p, p);
        else context()?.clearRect(0, 0, width, height);
      }}
      onPointerMove={(e) => {
        if (!tool || !start.current || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const p = point(e);
        if (tool === "brush") stroke(last.current ?? p, p);
        else drawBox(boxFrom(start.current, p));
        last.current = p;
      }}
      onPointerUp={(e) => {
        const from = start.current;
        start.current = null;
        if (!tool || !from) return;
        if (tool === "brush") return onStroke();
        const bbox = boxFrom(from, point(e));
        if (bbox[2] >= 4 && bbox[3] >= 4) {
          drawBox(bbox);
          onBox(bbox);
        } else {
          context()?.clearRect(0, 0, width, height); // a click, not a drag
        }
      }}
      onPointerCancel={() => {
        start.current = null;
      }}
    />
  );
}
