import type { GeneShape, GeneShapeKind, LinkRibbon } from "./layout";

/** Polygon approximation of an axis-aligned rounded rectangle. */
function roundedRectPoints(x0: number, x1: number, y: number, th: number): Array<[number, number]> {
  const top = y - th;
  const bot = y + th;
  const r = Math.min(th * 0.9, (x1 - x0) / 2, th);
  const steps = 5;
  const pts: Array<[number, number]> = [];
  // Corner arc centres, walked clockwise (screen space, +y is down).
  const corners: Array<[number, number, number, number]> = [
    [x1 - r, top + r, -Math.PI / 2, 0],           // top-right
    [x1 - r, bot - r, 0, Math.PI / 2],            // bottom-right
    [x0 + r, bot - r, Math.PI / 2, Math.PI],      // bottom-left
    [x0 + r, top + r, Math.PI, (3 * Math.PI) / 2], // top-left
  ];
  for (const [cx, cy, a0, a1] of corners) {
    for (let i = 0; i <= steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return pts;
}

/**
 * Strand-aware CDS polygon points for a given shape (shared by the canvas
 * renderer and SVG export). All shapes are closed polygons so both renderers
 * can treat the result identically.
 *
 * Orientation: forward-strand genes point at x1, reverse point at x0.
 * Directional shapes fall back to a plain box for strandless genes.
 *
 * - `triangle` rectangular body with a triangular head the same height as the
 *   body (default).
 * - `arrow`    block arrow whose head base flares wider than the (thinner)
 *   body before tapering to the point.
 * - `rounded`  rounded rectangle, no directionality.
 * - `box`      plain rectangle, no directionality.
 */
export function genePoints(
  g: GeneShape,
  h: number,
  shape: GeneShapeKind = "triangle",
  tipLength: number = h * 0.9,
): Array<[number, number]> {
  // Circular layout precomputes an annular wedge; use it verbatim.
  if (g.points) return g.points;
  const th = h / 2;
  const x0 = g.x0, x1 = g.x1, y = g.y;
  const len = Math.abs(x1 - x0);
  const tip = Math.min(tipLength, len);
  const fwd = g.strand >= 0;

  if (shape === "rounded") {
    return roundedRectPoints(x0, x1, y, th);
  }

  if (shape === "box" || g.strand === 0) {
    return [[x0, y - th], [x1, y - th], [x1, y + th], [x0, y + th]];
  }

  if (shape === "arrow") {
    // Body is thinner than the head; the head base (at the tip line) flares out
    // to the full height, giving the classic wide-shouldered block arrow.
    const bth = th * 0.6;
    return fwd
      ? [[x0, y - bth], [x1 - tip, y - bth], [x1 - tip, y - th], [x1, y], [x1 - tip, y + th], [x1 - tip, y + bth], [x0, y + bth]]
      : [[x1, y - bth], [x0 + tip, y - bth], [x0 + tip, y - th], [x0, y], [x0 + tip, y + th], [x0 + tip, y + bth], [x1, y + bth]];
  }

  // triangle (default): rectangular body + triangular head, same height.
  return fwd
    ? [[x0, y - th], [x1 - tip, y - th], [x1, y], [x1 - tip, y + th], [x0, y + th]]
    : [[x1, y - th], [x0 + tip, y - th], [x0, y], [x0 + tip, y + th], [x1, y + th]];
}

/** SVG path data for a homology-link ribbon (usable as Path2D in canvas too). */
export function ribbonPath(l: LinkRibbon, straight = false): string {
  // Circular layout precomputes a centre-pulled chord; use it verbatim.
  if (l.path) return l.path;
  if (straight) {
    return `M${l.ax0},${l.ay} L${l.bx0},${l.by} L${l.bx1},${l.by} L${l.ax1},${l.ay} Z`;
  }
  const midY = (l.ay + l.by) / 2;
  return (
    `M${l.ax0},${l.ay} C${l.ax0},${midY} ${l.bx0},${midY} ${l.bx0},${l.by} ` +
    `L${l.bx1},${l.by} C${l.bx1},${midY} ${l.ax1},${midY} ${l.ax1},${l.ay} Z`
  );
}
