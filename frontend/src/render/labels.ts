import type { ClusterLabel, GeneLabelMode, GeneLabelPosition, GeneShape, LayoutConfig } from "./layout";

// Type-only import above, so there is no runtime cycle with layout.ts (which
// imports measureLabel from here).

let measureCtx: CanvasRenderingContext2D | null | undefined;

function measureFont(text: string, font: string): number {
  if (measureCtx === undefined) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * parseFloat(font) * 0.55; // rough fallback (no DOM)
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/**
 * Width of a cluster name at its on-screen size. Cluster names always render at
 * exactly `clusterFontSize` CSS px regardless of zoom, so measuring at that size
 * is exact.
 */
export function measureLabel(name: string, fontSize: number): number {
  return measureFont(name, `600 ${fontSize}px system-ui, sans-serif`);
}

// Gene (CDS) labels render at a slightly lighter weight than cluster names; the
// measurement font must match the drawn font for truncation to be exact.
const GENE_LABEL_FONT = (fontSize: number) => `500 ${fontSize}px system-ui, sans-serif`;

export function measureGeneLabel(text: string, fontSize: number): number {
  return measureFont(text, GENE_LABEL_FONT(fontSize));
}

/** Longest ellipsised prefix of `text` fitting within `maxWidth`; "" if not even
 * one character plus the ellipsis fits (caller then drops the label). */
function truncateToWidth(text: string, fontSize: number, maxWidth: number): string {
  if (measureGeneLabel(text, fontSize) <= maxWidth) return text;
  let best = "";
  for (let i = 1; i < text.length; i++) {
    const cand = text.slice(0, i) + "…";
    if (measureGeneLabel(cand, fontSize) <= maxWidth) best = cand;
    else break;
  }
  return best;
}

/** A placed gene label in screen space. `x`,`y` is the label's *centre* (both axes);
 * renderers rotate around it, so it is anchor-agnostic (text-align/baseline centre). */
export interface GeneLabelPlacement {
  text: string;
  x: number;
  y: number;
}

export interface GeneLabelOpts {
  mode: GeneLabelMode;
  fontSize: number;
  /** World track height, to place labels relative to each arrow. */
  trackHeight: number;
  /** Above the arrow, or centred on it. */
  position: GeneLabelPosition;
  /** Label rotation in degrees (0 = horizontal). Sign is applied by renderers. */
  rotationDeg: number;
  /** When set, only these gene uids may be labelled (custom-group scope). */
  eligible: Set<string> | null;
}

/**
 * Adaptive CDS-label placement. Labels are centred on each gene and sit either just
 * above its arrow or on it (`position`), optionally rotated (`rotationDeg`). Text is
 * truncated to fit — to the gene's on-screen width when horizontal, or to a generous
 * cap when rotated (rotation exists precisely to fit long names on narrow genes). In
 * "auto" mode only genes wide enough on screen are labelled (labels reveal as you
 * zoom in; the width gate relaxes when rotated). A greedy pass ordered by on-screen
 * width drops any label whose rotated bounding box overlaps one already placed. Runs
 * in screen space with the live view, so it must be recomputed when zoom/pan change.
 */
export function placeGeneLabels(genes: GeneShape[], view: LabelView, opts: GeneLabelOpts): GeneLabelPlacement[] {
  if (opts.mode === "never") return [];
  const MIN_GENE_PX = 26; // auto: minimum on-screen gene width worth labelling (horizontal)
  const GAP = 4; // screen px between the label and the arrow's top edge ("above")
  const rotated = opts.rotationDeg !== 0;
  const rad = (opts.rotationDeg * Math.PI) / 180;
  const cosA = Math.abs(Math.cos(rad));
  const sinA = Math.abs(Math.sin(rad));
  const fh = opts.fontSize;
  // When rotated the along-text direction is no longer bounded by the gene width, so
  // allow a longer label; horizontal labels stay bounded by their gene.
  const ROT_MAX_PX = 260;
  const gate = rotated ? 12 : MIN_GENE_PX; // auto min on-screen gene width
  const placements: GeneLabelPlacement[] = [];
  const boxes: Array<[number, number, number, number]> = []; // [left, right, top, bottom]

  const cands = genes
    .filter((g) => g.label && (!opts.eligible || opts.eligible.has(g.uid)))
    .map((g) => {
      // Circular genes carry an explicit label anchor (their x0/x1/y are linear).
      if (g.labelAnchor) {
        const a = g.labelAnchor;
        const arrowTop = a.y * view.zoom + view.panY;
        return { g, w: a.w * view.zoom, cx: a.x * view.zoom + view.panX, arrowTop };
      }
      const w = Math.abs(g.x1 - g.x0) * view.zoom;
      const cx = ((g.x0 + g.x1) / 2) * view.zoom + view.panX;
      const arrowTop = (g.y - opts.trackHeight / 2) * view.zoom + view.panY;
      return { g, w, cx, arrowTop };
    })
    .filter((c) => opts.mode === "always" || c.w >= gate)
    .sort((a, b) => b.w - a.w); // wider genes win collisions

  const trackPx = opts.trackHeight * view.zoom;
  for (const c of cands) {
    const maxW = rotated ? ROT_MAX_PX : Math.max(c.w, MIN_GENE_PX);
    const text = truncateToWidth(c.g.label, opts.fontSize, maxW);
    if (!text) continue;
    const tw = measureGeneLabel(text, opts.fontSize);
    const x = c.cx;
    // Vertical centre of the label: on the arrow, or above it (clear of the arrow
    // plus the label's own half-height so it never overlaps the glyph).
    const arrowCentre = c.arrowTop + trackPx / 2;
    const y = opts.position === "on" ? arrowCentre : c.arrowTop - GAP - fh / 2;
    // Axis-aligned bounding box of the rotated label rectangle (tw × fh) about (x,y).
    const hx = cosA * tw / 2 + sinA * fh / 2;
    const hy = sinA * tw / 2 + cosA * fh / 2;
    const left = x - hx, right = x + hx, top = y - hy, bottom = y + hy;
    if (boxes.some((p) => left < p[1] && right > p[0] && top < p[3] && bottom > p[2])) continue;
    boxes.push([left, right, top, bottom]);
    placements.push({ text, x, y });
  }
  return placements;
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
