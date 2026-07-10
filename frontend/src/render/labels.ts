import type { ClusterLabel, LayoutConfig } from "./layout";

// Type-only import above, so there is no runtime cycle with layout.ts (which
// imports measureLabel from here).

let measureCtx: CanvasRenderingContext2D | null | undefined;

/**
 * Width of a cluster name at its on-screen size. Cluster names always render at
 * exactly `clusterFontSize` CSS px regardless of zoom, so measuring at that size
 * is exact.
 */
export function measureLabel(name: string, fontSize: number): number {
  if (measureCtx === undefined) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return name.length * fontSize * 0.55; // fallback estimate (no DOM)
  measureCtx.font = `600 ${fontSize}px system-ui, sans-serif`;
  return measureCtx.measureText(name).width;
}

export interface LabelView {
  zoom: number;
  panX: number;
  panY: number;
  cssW: number;
}

export interface LabelRect {
  /** Screen x of the text anchor (meaning depends on `align`). */
  x: number;
  /** Screen y of the text anchor: the baseline, or the middle when `middle`. */
  y: number;
  align: "left" | "right";
  middle: boolean;
  width: number;
  /** Screen-space bounding box of the drawn text (hit-testing, control placement). */
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Gap between a pinned label column and the edge of the canvas. */
const PINNED_PAD = 12;

/**
 * Screen-space placement of a cluster label — the single source of truth shared by
 * the canvas renderer, double-click hit-testing, the drag handle and the rename
 * editor, so they can never drift apart.
 *
 * When pinned, the label sticks to the canvas edge (stationary under pan/zoom) and
 * only its y tracks the cluster's row. Otherwise it sits at the world position the
 * layout computed and moves with the sequence.
 */
export function labelScreenRect(lab: ClusterLabel, cfg: LayoutConfig, view: LabelView): LabelRect {
  const fs = cfg.clusterFontSize;
  const width = measureLabel(lab.name, fs);
  const y = lab.y * view.zoom + view.panY;

  let x: number;
  let align: "left" | "right";
  if (cfg.clusterLabelPinned) {
    align = cfg.clusterLabelSide === "left" ? "left" : "right";
    x = align === "left" ? PINNED_PAD : view.cssW - PINNED_PAD;
  } else {
    align = lab.align;
    x = lab.x * view.zoom + view.panX;
  }

  const left = align === "left" ? x : x - width;
  // Vertical extent of the glyphs around the anchor, for hit-testing.
  const top = lab.middle ? y - fs * 0.6 : y - fs;
  const bottom = lab.middle ? y + fs * 0.6 : y + fs * 0.35;
  return { x, y, align, middle: lab.middle, width, left, right: left + width, top, bottom };
}
