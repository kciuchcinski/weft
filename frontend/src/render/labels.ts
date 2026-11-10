import type { ClusterLabel, GeneLabelMode, GeneLabelPosition, GeneLabelScope, GeneShape, GeneShapeKind, LayoutConfig } from "./layout";
import type { CustomGroup } from "./palette";

// Type-only imports above, so there is no runtime cycle with layout.ts (which
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

/** A placed gene label in screen space. `x`,`y` is the label's *centre* (both axes);
 * renderers rotate around it, so it is anchor-agnostic (text-align/baseline centre). */
export interface GeneLabelPlacement {
  text: string;
  x: number;
  y: number;
  /** Half-width/height of the rotated label's axis-aligned bounding box. */
  hx: number;
  hy: number;
  /** Text colour. */
  ink: string;
  /** Draw a background-coloured halo behind the text (labels off the arrow). */
  halo: boolean;
}

const DARK_INK = "#202124";
/** Screen px kept between a label inside a glyph and the glyph's outline. */
const BODY_PAD = 3;
const LIGHT_INK = "#ffffff";

/** WCAG relative luminance of a #rgb/#rrggbb colour; null if unparseable. */
function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
  const lin = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
}

/** Dark or white text, whichever contrasts more with `fill`. */
function inkOn(fill: string): string {
  const l = luminance(fill);
  if (l == null) return DARK_INK;
  const dark = luminance(DARK_INK)!;
  return (1.05 / (l + 0.05)) > ((l + 0.05) / (dark + 0.05)) ? LIGHT_INK : DARK_INK;
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
  /** Glyph shape and world tip length, so labels on the arrow keep off its head. */
  geneShape: GeneShapeKind;
  tipLength: number;
  /** When set, only these gene uids may be labelled (custom-group scope). */
  eligible: Set<string> | null;
}

/** Gene-label options from the layout config. Shared by the canvas and both exports
 * so they place labels identically. */
export function geneLabelOpts(cfg: LayoutConfig, eligible: Set<string> | null): GeneLabelOpts {
  return {
    mode: cfg.showGeneLabels,
    fontSize: cfg.geneLabelFontSize,
    trackHeight: cfg.trackHeight,
    position: cfg.geneLabelPosition,
    rotationDeg: cfg.geneLabelRotation,
    geneShape: cfg.geneShape,
    tipLength: cfg.tipLength,
    eligible,
  };
}

/**
 * Adaptive CDS-label placement. Labels sit either just above each gene's arrow, bottom
 * edges aligned (a tilted label starts at the gene's centre), or centred on it
 * (`position`), optionally rotated (`rotationDeg`). Text is never truncated: the
 * font size is the user's lever for fitting names. "always" draws every label even
 * where they overlap, leaving the trade-off to the user. In "auto" mode a horizontal
 * label appears only once its full name fits its gene (labels reveal as you zoom in),
 * a rotated one once the gene is a few px wide, and a greedy pass ordered by
 * on-screen width drops any label whose rotated bounding box overlaps one already
 * placed. Runs in screen space with the live view, so it must be recomputed when
 * zoom/pan change.
 */
export function placeGeneLabels(genes: GeneShape[], view: LabelView, opts: GeneLabelOpts): GeneLabelPlacement[] {
  if (opts.mode === "never") return [];
  const GAP = 4; // screen px between the label and the arrow's top edge ("above")
  const rotated = opts.rotationDeg !== 0;
  const rad = (opts.rotationDeg * Math.PI) / 180;
  const cosA = Math.abs(Math.cos(rad));
  const sinA = Math.abs(Math.sin(rad));
  const fh = opts.fontSize;
  const ROT_MIN_GENE_PX = 12; // auto: minimum on-screen gene width for a rotated label
  const placements: GeneLabelPlacement[] = [];
  const boxes: Array<[number, number, number, number]> = []; // [left, right, top, bottom]

  const cands = genes
    .filter((g) => g.label && (!opts.eligible || opts.eligible.has(g.uid)))
    .map((g) => {
      const w = Math.abs(g.x1 - g.x0) * view.zoom;
      const cx = ((g.x0 + g.x1) / 2) * view.zoom + view.panX;
      const arrowTop = (g.y - opts.trackHeight / 2) * view.zoom + view.panY;
      // The glyph's body: the gene minus its head on the side it points to (same
      // tip rule as genePoints), inset so text clears the outline.
      const pointed = (opts.geneShape === "triangle" || opts.geneShape === "arrow") && g.strand !== 0;
      const tip = pointed ? Math.min(opts.tipLength, Math.abs(g.x1 - g.x0)) * view.zoom : 0;
      const bodyW = w - tip - 2 * BODY_PAD;
      const bodyCx = cx + (pointed ? (g.strand > 0 ? -tip / 2 : tip / 2) : 0);
      return { g, w, cx, arrowTop, bodyW, bodyCx };
    })
    .filter((c) => opts.mode === "always" || !rotated || c.w >= ROT_MIN_GENE_PX)
    .sort((a, b) => b.w - a.w); // wider genes win collisions

  const trackPx = opts.trackHeight * view.zoom;
  const above = opts.position === "above";
  for (const c of cands) {
    const text = c.g.label;
    const tw = measureGeneLabel(text, opts.fontSize);
    // Auto mode: a horizontal label waits until its full name fits its gene.
    if (opts.mode === "auto" && !rotated && tw > (above ? c.w : c.bodyW)) continue;
    // A horizontal label on the arrow that fits the glyph's body sits inside it: it
    // takes the ink that reads best on the gene's fill and needs no halo. Anything
    // else crosses the background, ribbons or other rows, so it gets dark ink on a
    // background-coloured halo.
    const inside = !above && !rotated && fh <= trackPx && tw <= c.bodyW;
    // Half-extents of the axis-aligned bounding box of the rotated label (tw × fh).
    const hx = cosA * tw / 2 + sinA * fh / 2;
    const hy = sinA * tw / 2 + cosA * fh / 2;
    // On the arrow: centred on it. Above: the box's bottom edge sits GAP clear of the
    // arrow, so every label ends on one line whatever its length; a tilted label
    // starts at the gene's centre and runs up-right from there.
    const x = above && rotated ? c.cx + cosA * tw / 2 : inside ? c.bodyCx : c.cx;
    const y = above ? c.arrowTop - GAP - hy : c.arrowTop + trackPx / 2;
    const left = x - hx, right = x + hx, top = y - hy, bottom = y + hy;
    if (opts.mode === "auto" && boxes.some((p) => left < p[1] && right > p[0] && top < p[3] && bottom > p[2])) continue;
    boxes.push([left, right, top, bottom]);
    placements.push({ text, x, y, hx, hy, ink: inside ? inkOn(c.g.colour) : DARK_INK, halo: !inside });
  }
  return placements;
}

/** Gene uids eligible for CDS labels under `scope` (null = every gene). Shared by the
 * canvas and the exports so both label the same genes. */
export function geneLabelEligible(scope: GeneLabelScope, customGroups: CustomGroup[], genes: GeneShape[]): Set<string> | null {
  if (scope === "custom") return new Set(customGroups.flatMap((g) => g.genes));
  if (scope === "top") return new Set(genes.filter((g) => g.lane === 0).map((g) => g.uid));
  return null;
}

/**
 * `bounds` grown to cover gene labels placed at `zoom` with no pan. Scene bounds
 * leave labels out (they are placed per view), so exports grow theirs with this or
 * clip tall rotated labels on the top row.
 */
export function boundsWithGeneLabels(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  placements: GeneLabelPlacement[],
  zoom: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  let { minX, minY, maxX, maxY } = bounds;
  for (const p of placements) {
    minX = Math.min(minX, (p.x - p.hx) / zoom);
    maxX = Math.max(maxX, (p.x + p.hx) / zoom);
    minY = Math.min(minY, (p.y - p.hy) / zoom);
    maxY = Math.max(maxY, (p.y + p.hy) / zoom);
  }
  return { minX, minY, maxX, maxY };
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
