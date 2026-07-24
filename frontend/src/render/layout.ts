import type { FigureData, Gene, Link, MetricKey } from "../types";
import { UNGROUPED, type LegendItem } from "./palette";
import { measureLabel } from "./labels";

// Shared offscreen canvas for measuring rendered text width. Layout is renderer-
// agnostic, so we measure with the same font the canvas/SVG renderers use rather
// than guessing from character count — guesses under-measure wide labels and make
// legend entries overlap. Falls back to a rough estimate outside the browser.
let measureCtx: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, fontPx: number): number {
  if (measureCtx === undefined) {
    measureCtx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
  }
  if (!measureCtx) return text.length * fontPx * 0.55;
  measureCtx.font = `${fontPx}px system-ui, sans-serif`;
  return measureCtx.measureText(text).width;
}

/** Selectable CDS glyph shapes (see genePoints in geometry.ts). */
export type GeneShapeKind = "triangle" | "arrow" | "rounded" | "box";

/** Cluster-name placement relative to its sequence track. */
export type ClusterLabelPlacement = "above" | "beside";
export type ClusterLabelSide = "left" | "right";

/** CDS-label visibility: never; always (per gene in scope, truncated to fit); or
 * auto (only once a gene is wide enough on screen — labels appear as you zoom in). */
export type GeneLabelMode = "auto" | "always" | "never";
/** Which genes may be labelled: every gene, or only custom-group members. */
export type GeneLabelScope = "all" | "custom";
/** Where a CDS label sits relative to its arrow: above it, or centred on it. */
export type GeneLabelPosition = "above" | "on";

/**
 * The text to label a gene with, for a chosen qualifier field. When `field` is set
 * and present use it; otherwise fall back through the conventional names (gene →
 * locus_tag → protein_id) and finally the gene's own label.
 */
export function resolveGeneLabel(gene: Gene, field: string): string {
  if (field && gene.names[field]) return gene.names[field];
  return gene.names.gene || gene.names.locus_tag || gene.names.protein_id || gene.label || "";
}

// Qualifier keys that answer "what does this protein do", in the order a reader
// wants them. Matched as a case-insensitive *prefix*, because domain annotators
// number their hits: PFAM1, PFAM2, ECOD1, PHROGS1 all rank under their family.
// Everything unlisted still shows — it just sorts afterwards, so a capped tooltip
// spends its budget on function rather than on bookkeeping like transl_table.
const QUALIFIER_PRIORITY = [
  "product",
  "function",
  "gene",
  "note",
  "pfam",
  "ecod",
  "cog",
  "kegg",
  "tigrfam",
  "interpro",
  "phrog",
  "alan",
  "ec_number",
  "go",
  "db_xref",
  "locus_tag",
  "protein",
];

// Per-hit statistics that accompany a domain call (PFAM1_bits, ECOD1_evalue…).
// They belong with their hit but below every actual annotation, so a reader sees
// what was found before how well it scored.
const STAT_SUFFIX = /_(bits|evalue|e_value|score|function_sig|sig|coverage|pident)$/i;

/**
 * A gene's qualifiers ordered for display: functional annotation first (see
 * QUALIFIER_PRIORITY), then hit statistics, then everything else alphabetically.
 * Empty hits — annotators write "-" for "nothing found" — sort last so they never
 * crowd out real content, but are still listed. `max` caps the list; 0 means all.
 *
 * Shared by the hover tooltip and the gene inspector so both present the same
 * fields in the same order.
 */
export function qualifierEntries(gene: Gene, max = 0): [string, string][] {
  const rank = (key: string): number => {
    const k = key.toLowerCase();
    const i = QUALIFIER_PRIORITY.findIndex((p) => k.startsWith(p));
    const base = i < 0 ? QUALIFIER_PRIORITY.length : i;
    // Demote statistics a whole band below the annotations they describe.
    return STAT_SUFFIX.test(k) ? base + QUALIFIER_PRIORITY.length + 1 : base;
  };
  // "-" is the no-hit placeholder used by PFAM/ECOD/PHROGS annotation tables.
  const empty = (v: string) => v.trim() === "-";
  const entries = Object.entries(gene.names).filter(([, v]) => v !== "" && v != null);
  return entries
    .sort(
      (a, b) =>
        Number(empty(a[1])) - Number(empty(b[1])) ||
        rank(a[0]) - rank(b[0]) ||
        a[0].localeCompare(b[0]),
    )
    .slice(0, max > 0 ? max : entries.length);
}

/** Gap between a pinned name column and the figure's edge, in SVG export. */
const LABEL_PIN_GAP = 12;

export interface LayoutConfig {
  pxPerBp: number;
  trackHeight: number;
  rowGap: number;
  locusGap: number;
  colGap: number;
  preventOverlap: boolean;
  labelGap: number;
  tipLength: number;
  geneShape: GeneShapeKind;
  geneStroke: string;
  geneStrokeWidth: number;
  showClusterNames: boolean;
  clusterFontSize: number;
  /** Cluster name above the sequence, or beside it (vertically centred). */
  clusterLabelPlacement: ClusterLabelPlacement;
  /** Which end of the cluster the name hugs. */
  clusterLabelSide: ClusterLabelSide;
  /** Stick the names to the canvas edge (stationary under pan/zoom) instead of
   * letting them move with their sequence. In SVG export — which has no viewport —
   * pinned names form a column against the figure's corresponding edge. */
  clusterLabelPinned: boolean;
  showLinks: boolean;
  straight: boolean;
  /** When true, ribbons inherit the shared colour of matching endpoints; when
   * false, all ribbons render in a neutral grey. */
  colourLinks: boolean;
  /** Draw the active similarity metric's value at each ribbon's midpoint. */
  showLinkLabels: boolean;
  /** Anchor ribbons to each link's aligned sub-region (when the link carries one)
   * rather than the full gene extent, so partial-similarity matches read as a
   * narrowed ribbon. Falls back to full extent when no span is present. */
  anchorLinksToAligned: boolean;
  linkOpacity: number;
  linkThreshold: number;
  /** Hide partial-similarity links whose shared aligned region is shorter than
   * this many residues (amino acids). 0 = off. Only affects links carrying an
   * aligned span (parasail local); whole-gene links are never filtered by it. */
  minFragmentAa: number;
  // Backbone (the sequence line behind each locus).
  backboneColour: string;
  backboneWidth: number;
  backboneOpacity: number;
  background: string;
  // Scale bar + colour legend, drawn below the figure (world space, so they
  // scale with the figure and export cleanly). Both independently togglable.
  showScaleBar: boolean;
  scaleFontSize: number;
  /** Fixed scale-bar length in bp; 0 uses an auto-chosen round value. */
  scaleBarBp: number;
  /** Scale-bar line thickness in world units. */
  scaleBarThickness: number;
  showLegend: boolean;
  legendFontSize: number;
  /** Horizontal gap between legend entries in world units. */
  legendSpacing: number;
  // CDS (gene) labels — adaptive, horizontal, placed at render time (see labels.ts).
  showGeneLabels: GeneLabelMode;
  geneLabelFontSize: number;
  /** Qualifier key resolved into each GeneShape.label ("" = fallback chain). */
  geneLabelField: string;
  /** Above the arrow, or centred on it. */
  geneLabelPosition: GeneLabelPosition;
  /** Label rotation in degrees (0 = horizontal; positive tilts upward to the right). */
  geneLabelRotation: number;
}

export const DEFAULT_LAYOUT: LayoutConfig = {
  pxPerBp: 0.05,
  trackHeight: 16,
  rowGap: 54,
  locusGap: 24,
  colGap: 64,
  preventOverlap: true,
  labelGap: 18,
  tipLength: 14,
  geneShape: "triangle",
  geneStroke: "#33383f",
  geneStrokeWidth: 0.7,
  showClusterNames: true,
  clusterFontSize: 13,
  clusterLabelPlacement: "above",
  clusterLabelSide: "left",
  clusterLabelPinned: false,
  showLinks: true,
  straight: false,
  colourLinks: true,
  showLinkLabels: false,
  anchorLinksToAligned: true,
  linkOpacity: 1,
  linkThreshold: 0,
  minFragmentAa: 0,
  backboneColour: "#c2c7ce",
  backboneWidth: 1,
  backboneOpacity: 1,
  background: "#ffffff",
  showScaleBar: true,
  scaleFontSize: 13,
  scaleBarBp: 0,
  scaleBarThickness: 1.5,
  showLegend: true,
  legendFontSize: 13,
  legendSpacing: 18,
  showGeneLabels: "never",
  geneLabelFontSize: 11,
  geneLabelField: "",
  geneLabelPosition: "above",
  geneLabelRotation: 0,
};

export interface GeneShape {
  uid: string;
  cluster: number;
  lane: number;
  x0: number;
  x1: number;
  y: number;
  strand: number;
  colour: string;
  label: string;
}

export interface LocusLine {
  x0: number; x1: number; y: number;
  /** Owning cluster index. */
  cluster?: number;
}
/**
 * Where a cluster's *sequence* sits, in world coordinates. Always one per cluster.
 *
 * Kept separate from the drawn label: drag-reorder, drop zones and the control pill
 * depend on where the sequence is, never on where its name happens to be placed
 * (which may be a pinned column, or merged with its row-mates).
 */
export interface ClusterBox {
  uid: string;
  lane: number;
  x0: number;
  x1: number;
  w: number;
  /** World y of the sequence track (the gene row). */
  trackY: number;
}

/**
 * A drawn name. Usually one per cluster, but when names are pinned and a row holds
 * several clusters their names would stack on the same spot, so the row merges into
 * a single label the user can name independently (`kind: "row"`).
 */
export interface ClusterLabel {
  /** A cluster uid, or a stable row key (see `rowKey`) when several merged. */
  id: string;
  kind: "cluster" | "row";
  name: string;
  /** World x of the text anchor (interpretation depends on `align`). */
  x: number;
  /** World y of the text anchor: baseline when `middle` is false, else the middle. */
  y: number;
  align: ClusterLabelSide;
  /** Vertically centre the text on the track (the "beside" placement). */
  middle: boolean;
  lane: number;
  /** Cluster uids this label stands for. */
  members: string[];
}

/** Stable identity for a merged row, independent of the clusters' visual order. */
export function rowKey(members: string[]): string {
  return [...members].sort().join("|");
}
export interface LinkRibbon {
  ax0: number; ax1: number; ay: number;
  bx0: number; bx1: number; by: number;
  colour: string; alpha: number;
  /** Midpoint of the ribbon, where the metric value label is drawn. */
  mx: number; my: number;
  /** Formatted active-metric value, present only when link labels are enabled. */
  label?: string;
  /** The source homology link, for hover tooltips (connected genes + metrics). */
  link: Link;
}

/** Horizontal scale bar (a nice round bp length) drawn below the figure. */
export interface ScaleBar {
  x0: number;
  x1: number;
  y: number;
  tick: number;
  strokeWidth: number;
  label: string;
  labelX: number;
  labelY: number;
  fontSize: number;
}

/** One swatch + label row in the colour legend. */
export interface LegendSwatch {
  x: number;
  y: number;
  size: number;
  colour: string;
  label: string;
  textX: number;
  textY: number;
}

export interface Legend {
  entries: LegendSwatch[];
  fontSize: number;
}

export interface Scene {
  genes: GeneShape[];
  loci: LocusLine[];
  /** One per cluster: sequence geometry, for controls and drag-reorder. */
  clusters: ClusterBox[];
  /** Drawn names; may be fewer than clusters when a pinned row is merged. */
  labels: ClusterLabel[];
  links: LinkRibbon[];
  scaleBar?: ScaleBar;
  legend?: Legend;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Round bp length whose on-figure width is close to `targetPx` (1/2/5 × 10ⁿ). */
function niceScaleBp(pxPerBp: number, targetPx = 150): number {
  if (!(pxPerBp > 0)) return 1000;
  const raw = targetPx / pxPerBp;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const frac = raw / pow;
  const nice = frac >= 5 ? 5 : frac >= 2 ? 2 : 1;
  return Math.max(1, nice * pow);
}

function formatBp(bp: number): string {
  if (bp >= 1000) {
    const kb = bp / 1000;
    return `${Number.isInteger(kb) ? kb : kb.toFixed(1)} kb`;
  }
  return `${Math.round(bp)} bp`;
}

/**
 * Resolve the effective lane layout: an ordered list of rows, each an ordered
 * list of cluster uids. Filters out unknown/duplicate uids and appends any
 * cluster missing from `lanes` as its own row, so the result always covers
 * every cluster exactly once regardless of how stale `lanes` is.
 */
export function effectiveLanes(data: FigureData, lanes?: string[][]): string[][] {
  const valid = new Set(data.clusters.map((c) => c.uid));
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const lane of lanes ?? []) {
    const filtered = lane.filter((u) => valid.has(u) && !seen.has(u));
    filtered.forEach((u) => seen.add(u));
    if (filtered.length) out.push(filtered);
  }
  for (const c of data.clusters) {
    if (!seen.has(c.uid)) out.push([c.uid]);
  }
  return out;
}

/**
 * Map an aligned sub-region [f0,f1] (fractions of protein length, N→C terminus)
 * to the world-x span it occupies on a laid-out gene. The N-terminus sits at `x0`
 * for forward-reading genes (`strand >= 0`) and at `x1` for reverse ones.
 *
 * This single rule also handles reversed clusters with no special case: a reversed
 * gene has its `x0/x1` mirrored AND its `strand` flipped together (see
 * `placeCluster`), so the N-terminus always resolves to the correct world edge.
 * Returns `[lo, hi]` with `lo <= hi` since ribbon anchors require it.
 */
function spanToWorldX(g: GeneShape, f0: number, f1: number): [number, number] {
  const w = g.x1 - g.x0;
  const clamp01 = (f: number) => (f < 0 ? 0 : f > 1 ? 1 : f);
  const at = (f: number) => (g.strand >= 0 ? g.x0 + clamp01(f) * w : g.x1 - clamp01(f) * w);
  const a = at(f0);
  const b = at(f1);
  return a <= b ? [a, b] : [b, a];
}

/** Normalise a metric value to [0,1] for link opacity. */
function normaliseMetric(value: number | null | undefined, metric: MetricKey): number {
  if (value == null) return 0;
  if (metric === "evalue") return value <= 0 ? 1 : Math.max(0, Math.min(1, 1 + Math.log10(value) / -10));
  if (metric === "bitscore") return Math.max(0, Math.min(1, value / 1000));
  return Math.max(0, Math.min(1, value)); // identity / similarity / coverage / jaccard
}

/** E-value is the only metric where a smaller value is a stronger match. */
export function metricLowerIsBetter(metric: MetricKey): boolean {
  return metric === "evalue";
}

// Canonical display order for metrics; jaccard is reserved (never produced yet).
const METRIC_ORDER: MetricKey[] = ["identity", "similarity", "coverage", "bitscore", "evalue", "jaccard"];

/**
 * Metrics actually populated by the alignment that produced this data — a metric
 * is available when at least one link carries a non-null value for it. DIAMOND
 * fills all of identity/similarity/coverage/bitscore/evalue; parasail fills only
 * the fraction metrics (identity/similarity/coverage). Lets the UI offer exactly
 * the metrics that mean something for the loaded figure.
 */
export function availableMetrics(data: FigureData | null): MetricKey[] {
  if (!data) return [];
  return METRIC_ORDER.filter((m) => data.links.some((l) => l.metrics[m] != null));
}

/**
 * True when the data carries aligned sub-regions that are actually partial (a
 * local/Smith–Waterman alignment). Global alignments span the full protein, so
 * their spans are ~(0,1) and this returns false.
 */
export function hasPartialSpans(data: FigureData | null): boolean {
  if (!data) return false;
  return data.links.some(
    (l) =>
      l.query_start != null &&
      l.query_end != null &&
      (l.query_start > 0.005 || l.query_end < 0.995 || (l.target_start ?? 0) > 0.005 || (l.target_end ?? 1) < 0.995),
  );
}

/**
 * Describe the alignment that produced the loaded figure, inferred from the
 * links themselves (robust regardless of the current engine/mode selection,
 * which only applies to the *next* upload). DIAMOND links carry bitscore/e-value;
 * parasail links carry aligned spans (partial → local, full-length → global).
 */
export function describeAlignment(data: FigureData | null): { engine: string | null; mode: string | null } {
  if (!data || data.links.length === 0) return { engine: null, mode: null };
  if (data.links.some((l) => l.metrics.bitscore != null || l.metrics.evalue != null)) {
    return { engine: "DIAMOND", mode: null };
  }
  if (data.links.some((l) => l.query_start != null)) {
    return { engine: "parasail", mode: hasPartialSpans(data) ? "local" : "global" };
  }
  return { engine: null, mode: null };
}

/** Protein length in residues per gene uid (translation length, else bp/3). */
export function geneAaLengths(data: FigureData): Map<string, number> {
  const lens = new Map<string, number>();
  for (const c of data.clusters) {
    for (const l of c.loci) {
      for (const g of l.genes) {
        const aa = g.translation && g.translation.length > 0 ? g.translation.length : Math.max(1, Math.round((g.end - g.start) / 3));
        lens.set(g.uid, aa);
      }
    }
  }
  return lens;
}

/** Aligned-region length in residues (the smaller of the two proteins), or null
 * when the link has no aligned span. */
export function linkFragmentAa(link: Link, aaLens: Map<string, number>): number | null {
  if (link.query_start == null || link.query_end == null) return null;
  const qAa = aaLens.get(link.query) ?? 0;
  const tAa = aaLens.get(link.target) ?? 0;
  const qFrag = (link.query_end - link.query_start) * qAa;
  const tFrag = ((link.target_end ?? 1) - (link.target_start ?? 0)) * tAa;
  return Math.min(qFrag, tFrag);
}

/** Short, human-readable rendering of a raw metric value for on-link labels. */
export function formatMetric(value: number | null | undefined, metric: MetricKey): string {
  if (value == null || Number.isNaN(value)) return "";
  switch (metric) {
    case "identity":
    case "similarity":
    case "coverage":
    case "jaccard":
      return `${Math.round(value * 100)}%`;
    case "bitscore":
      return value >= 1000 ? value.toPrecision(3) : String(Math.round(value));
    case "evalue":
      return value === 0 ? "0" : value.toExponential(0);
    default:
      return String(value);
  }
}

/**
 * A link passes the threshold when its raw metric value clears the cutoff in the
 * metric's own units: for E-value the raw value must be at or below the cutoff
 * (lower is better), for every other metric it must be at or above it.
 */
function passesThreshold(value: number | null | undefined, metric: MetricKey, threshold: number): boolean {
  if (value == null) return false;
  return metricLowerIsBetter(metric) ? value <= threshold : value >= threshold;
}

/** Compute a drawable scene (world coordinates) from figure data + lanes + config + gene colours. */
export function buildScene(
  data: FigureData,
  lanes: string[][] | undefined,
  cfg: LayoutConfig,
  geneColour: Map<string, string>,
  metric: MetricKey,
  clusterOffsets: Record<string, number> = {},
  /** Cluster currently being slid horizontally; it stays under the cursor while
   * overlap resolution pushes its neighbours aside instead of pinning it. */
  anchorUid?: string,
  /** Colour legend rows (from computeColours); drawn below the figure. */
  legendItems: LegendItem[] = [],
  /** User-chosen names for merged rows, keyed by `rowKey` of their members. */
  rowNames: Record<string, string> = {},
  /** Clusters treated as circular sequences (origin can be rotated), keyed by uid. */
  circularClusters: Record<string, boolean> = {},
  /** Per-cluster origin rotation in whole-CDS steps (only used when circular). */
  clusterRotation: Record<string, number> = {},
): Scene {
  const genes: GeneShape[] = [];
  const loci: LocusLine[] = [];
  const clusterBoxes: ClusterBox[] = [];
  const labels: ClusterLabel[] = [];
  const shapeByUid = new Map<string, GeneShape>();
  const indexByUid = new Map(data.clusters.map((c, i) => [c.uid, i]));

  const clusterWidth = (ci: number): number => {
    const c = data.clusters[ci];
    return c.loci.reduce((w, l, i) => w + (l.end - l.start) * cfg.pxPerBp + (i > 0 ? cfg.locusGap : 0), 0);
  };

  const placeCluster = (ci: number, originX: number, originY: number, laneIdx: number) => {
    const c = data.clusters[ci];
    // A reversed cluster is mirrored horizontally within its own extent, so it
    // reads right-to-left with every gene's strand flipped.
    const reversed = !!c.reversed;
    const width = clusterWidth(ci);
    const toAbs = (relX: number) => originX + relX;
    const mirror = (absX: number) => 2 * originX + width - absX;
    clusterBoxes.push({
      uid: c.uid,
      lane: laneIdx,
      x0: originX,
      x1: originX + width,
      w: width,
      trackY: originY,
    });

    // First pass: gene + locus positions in cluster-relative coords [0, width].
    const relGenes: { g: Gene; x0: number; x1: number }[] = [];
    const relLoci: { x0: number; x1: number }[] = [];
    let cursor = 0;
    for (const locus of c.loci) {
      const w = (locus.end - locus.start) * cfg.pxPerBp;
      relLoci.push({ x0: cursor, x1: cursor + w });
      for (const g of locus.genes) {
        relGenes.push({
          g,
          x0: cursor + (g.start - locus.start) * cfg.pxPerBp,
          x1: cursor + (g.end - locus.start) * cfg.pxPerBp,
        });
      }
      cursor += w + cfg.locusGap;
    }

    // Circular origin rotation: cyclically shift the sequence so the chosen origin
    // gene starts at x=0. The origin snaps to a gene's left edge, so no gene ever
    // straddles the cut — genes before the origin wrap intact to the right end.
    const isCircular = !!circularClusters[c.uid];
    let R = 0;
    if (isCircular && relGenes.length) {
      const n = relGenes.length;
      const k = (((clusterRotation[c.uid] ?? 0) % n) + n) % n;
      R = relGenes[k].x0;
    }
    const rotate = (x0: number, x1: number): [number, number] => {
      if (!R) return [x0, x1];
      let n0 = x0 - R;
      let n1 = x1 - R;
      if (n0 < -1e-6) { n0 += width; n1 += width; } // wrapped: shift the whole gene
      return [n0, n1];
    };

    // Backbone: a circular cluster is one continuous loop, so draw a single line over
    // the full extent; a linear cluster keeps its per-locus segments (with gaps).
    const emitLocus = (rel0: number, rel1: number) => {
      const a0 = toAbs(rel0), a1 = toAbs(rel1);
      loci.push(reversed
        ? { x0: mirror(a1), x1: mirror(a0), y: originY, cluster: ci }
        : { x0: a0, x1: a1, y: originY, cluster: ci });
    };
    if (isCircular) emitLocus(0, width);
    else for (const rl of relLoci) emitLocus(rl.x0, rl.x1);

    for (const rg of relGenes) {
      const [r0, r1] = rotate(rg.x0, rg.x1);
      const a0 = toAbs(r0), a1 = toAbs(r1);
      const shape: GeneShape = {
        uid: rg.g.uid,
        cluster: ci,
        lane: laneIdx,
        x0: reversed ? mirror(a1) : a0,
        x1: reversed ? mirror(a0) : a1,
        y: originY,
        strand: reversed ? -rg.g.strand : rg.g.strand,
        colour: geneColour.get(rg.g.uid) ?? UNGROUPED,
        label: resolveGeneLabel(rg.g, cfg.geneLabelField),
      };
      genes.push(shape);
      shapeByUid.set(rg.g.uid, shape);
    }
  };

  // Minimum edge-to-edge separation kept between clusters when overlap is
  // prevented. Small enough to still read as "moved close", large enough that
  // arrows/labels don't visually merge.
  const OVERLAP_GAP = 10;

  const eff = effectiveLanes(data, lanes);
  eff.forEach((lane, laneIdx) => {
    const originY = laneIdx * (cfg.trackHeight + cfg.rowGap) + cfg.labelGap + cfg.trackHeight;

    // Base X is sequential left-to-right packing; the per-cluster offset lets the
    // user slide a cluster horizontally within its row on top of that.
    let cursorX = 0;
    const placed: { ci: number; uid: string; x: number; w: number }[] = [];
    for (const uid of lane) {
      const ci = indexByUid.get(uid);
      if (ci == null) continue;
      const w = clusterWidth(ci);
      placed.push({ ci, uid, x: cursorX + (clusterOffsets[uid] ?? 0), w });
      cursorX += w + cfg.colGap;
    }

    if (cfg.preventOverlap) {
      const anchor = anchorUid ? placed.find((p) => p.uid === anchorUid) : undefined;
      if (anchor) {
        // Keep the dragged cluster exactly under the cursor and shove its
        // neighbours outward on either side, so it can pass others smoothly
        // instead of snapping/teleporting when their desired positions cross.
        let leftBound = anchor.x;
        for (const p of placed.filter((p) => p !== anchor && p.x < anchor.x).sort((a, b) => b.x - a.x)) {
          const maxRight = leftBound - OVERLAP_GAP;
          if (p.x + p.w > maxRight) p.x = maxRight - p.w;
          leftBound = p.x;
        }
        let rightBound = anchor.x + anchor.w;
        for (const p of placed.filter((p) => p !== anchor && p.x >= anchor.x).sort((a, b) => a.x - b.x)) {
          const minLeft = rightBound + OVERLAP_GAP;
          if (p.x < minLeft) p.x = minLeft;
          rightBound = p.x + p.w;
        }
      } else {
        // No active drag: resolve in visual (desired-X) order, pushing each
        // cluster right just enough to clear the previous one.
        const order = [...placed].sort((a, b) => a.x - b.x);
        let minLeft = -Infinity;
        for (const p of order) {
          if (p.x < minLeft) p.x = minLeft;
          minLeft = p.x + p.w + OVERLAP_GAP;
        }
      }
    }

    for (const p of placed) placeCluster(p.ci, p.x, originY, laneIdx);
  });

  // Names, built once every cluster's final x is known.
  //
  // Unpinned names sit at their own cluster's end (placement is always "above"
  // there — "beside" is normalised to pinned, since an unpinned beside-name would
  // land on the neighbouring cluster). Pinned names share one column, so a row with
  // several clusters would stack them all at the same point: merge those into a
  // single row label the user can name independently. Their per-cluster names are
  // untouched and reappear when the row is split.
  {
    const above = cfg.clusterLabelPlacement === "above";
    const atLeft = cfg.clusterLabelSide === "left";
    const pinned = cfg.clusterLabelPinned;
    const nameByUid = new Map(data.clusters.map((c) => [c.uid, c.name]));

    const byLane = new Map<number, ClusterBox[]>();
    for (const b of clusterBoxes) {
      const bucket = byLane.get(b.lane);
      if (bucket) bucket.push(b);
      else byLane.set(b.lane, [b]);
    }

    for (const [laneIdx, boxes] of byLane) {
      boxes.sort((a, b) => a.x0 - b.x0);
      const trackY = boxes[0].trackY;
      // x is finalised in the pinned pass below; align already reads away from the figure.
      const y = above ? trackY - cfg.trackHeight : trackY;
      const middle = !above;

      if (pinned && boxes.length > 1) {
        const members = boxes.map((b) => b.uid);
        const id = rowKey(members);
        labels.push({
          id,
          kind: "row",
          name: rowNames[id] ?? members.map((u) => nameByUid.get(u) ?? u).join(", "),
          x: 0,
          y,
          align: atLeft ? "right" : "left",
          middle,
          lane: laneIdx,
          members,
        });
      } else {
        for (const b of boxes) {
          labels.push({
            id: b.uid,
            kind: "cluster",
            name: nameByUid.get(b.uid) ?? b.uid,
            x: pinned ? 0 : atLeft ? b.x0 : b.x1,
            y,
            align: pinned ? (atLeft ? "right" : "left") : atLeft ? "left" : "right",
            middle,
            lane: laneIdx,
            members: [b.uid],
          });
        }
      }
    }
  }

  // Links between genes on vertically adjacent lanes.
  const links: LinkRibbon[] = [];
  // Protein lengths, only needed when the fragment-length filter is active.
  const aaLens = cfg.minFragmentAa > 0 ? geneAaLengths(data) : null;
  if (cfg.showLinks) {
    for (const link of data.links) {
      const a = shapeByUid.get(link.query);
      const b = shapeByUid.get(link.target);
      if (!a || !b || Math.abs(a.lane - b.lane) !== 1) continue;
      if (!passesThreshold(link.metrics[metric], metric, cfg.linkThreshold)) continue;
      if (aaLens) {
        // Only partial-similarity links carry a fragment length; whole-gene links
        // (fragment == null) are never dropped by this filter.
        const frag = linkFragmentAa(link, aaLens);
        if (frag != null && frag < cfg.minFragmentAa) continue;
      }
      const norm = normaliseMetric(link.metrics[metric], metric);
      const upper = a.lane < b.lane ? a : b;
      const lower = a.lane < b.lane ? b : a;
      const ca = geneColour.get(a.uid);
      const sameColour = cfg.colourLinks && !!ca && ca === geneColour.get(b.uid);
      // Anchor the ribbon at each track's centreline. By default it spans the full
      // gene extent (tip to end); when the link carries an aligned sub-region and
      // anchoring is enabled, it narrows to just that region so partial-similarity
      // matches read as a slimmer ribbon. Arrows are drawn on top, so the ribbon
      // always meets the arrow cleanly regardless of tip size.
      const spanFor = (shape: GeneShape, isQuery: boolean): [number, number] => {
        const s0 = isQuery ? link.query_start : link.target_start;
        const s1 = isQuery ? link.query_end : link.target_end;
        return cfg.anchorLinksToAligned && s0 != null && s1 != null
          ? spanToWorldX(shape, s0, s1)
          : [shape.x0, shape.x1];
      };
      const upperIsQuery = upper === a;
      const [ax0, ax1] = spanFor(upper, upperIsQuery);
      const [bx0, bx1] = spanFor(lower, !upperIsQuery);
      links.push({
        ax0, ax1, ay: upper.y,
        bx0, bx1, by: lower.y,
        colour: sameColour ? (ca as string) : "#9aa0a6",
        alpha: Math.max(0, Math.min(1, (0.12 + 0.5 * norm) * cfg.linkOpacity)),
        mx: (ax0 + ax1 + bx0 + bx1) / 4,
        my: (upper.y + lower.y) / 2,
        label: cfg.showLinkLabels ? formatMetric(link.metrics[metric], metric) : undefined,
        link,
      });
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const g of genes) { acc(g.x0, g.y - cfg.trackHeight); acc(g.x1, g.y + cfg.trackHeight); }

  // Horizontal extent of the sequence rows alone. The scale bar and legend align to
  // the tracks, so they must not drift when a name column widens the overall bounds.
  const figMinX = isFinite(minX) ? minX : 0;
  const figMaxX = isFinite(maxX) ? maxX : 1;

  // Pinned names stick to the canvas edge on screen, but an exported figure has no
  // viewport — so pin them to the figure's own edge instead, forming a clean column
  // beside the tracks. Done after the gene pass so the figure extent is known.
  if (cfg.clusterLabelPinned && isFinite(minX)) {
    const atLeft = cfg.clusterLabelSide === "left";
    const pinX = atLeft ? figMinX - LABEL_PIN_GAP : figMaxX + LABEL_PIN_GAP;
    for (const l of labels) l.x = pinX;
  }

  // Grow the bounds around each name's drawn extent, or the SVG viewBox clips
  // labels that reach outside the gene rows (beside/right-aligned/pinned).
  if (cfg.showClusterNames) {
    for (const l of labels) {
      const w = measureLabel(l.name, cfg.clusterFontSize);
      const lx0 = l.align === "left" ? l.x : l.x - w;
      acc(lx0, l.y - cfg.clusterFontSize);
      acc(lx0 + w, l.y + cfg.clusterFontSize * 0.4);
    }
  }

  const figureBottom = isFinite(maxY) ? maxY : 0;
  const footerGap = 36;
  let footerY = figureBottom + footerGap;

  let scaleBar: ScaleBar | undefined;
  if (cfg.showScaleBar) {
    const bp = cfg.scaleBarBp > 0 ? cfg.scaleBarBp : niceScaleBp(cfg.pxPerBp);
    const barW = bp * cfg.pxPerBp;
    const x0 = figMinX;
    const tick = Math.max(4, cfg.scaleFontSize * 0.45);
    // Label sits a clear gap above the bar so it never touches the line, whatever
    // the font size. All vertical offsets scale with the font to avoid overlap.
    const label = formatBp(bp);
    const labelY = footerY + cfg.scaleFontSize;
    const y = labelY + cfg.scaleFontSize * 0.9 + tick;
    const labelX = x0 + barW / 2;
    const labelW = textWidth(label, cfg.scaleFontSize);
    scaleBar = {
      x0,
      x1: x0 + barW,
      y,
      tick,
      strokeWidth: cfg.scaleBarThickness,
      label,
      labelX,
      labelY,
      fontSize: cfg.scaleFontSize,
    };
    acc(Math.min(x0, labelX - labelW / 2), labelY - cfg.scaleFontSize);
    acc(Math.max(x0 + barW, labelX + labelW / 2), y + tick);
    footerY = y + tick + cfg.scaleFontSize;
  }

  let legend: Legend | undefined;
  if (cfg.showLegend && legendItems.length > 0) {
    const swatch = Math.max(10, cfg.legendFontSize);
    const pad = 6;
    const entryGap = cfg.legendSpacing;
    const rowStride = swatch + Math.max(8, cfg.legendSpacing * 0.5);
    // Wrap to the figure's right edge as it stands before the legend (the legend
    // itself extends maxX below, so capture it first).
    const rightEdge = figMaxX;
    let x = figMinX;
    let y = footerY + swatch / 2;
    const entries: LegendSwatch[] = [];
    for (const item of legendItems) {
      const textW = textWidth(item.label, cfg.legendFontSize);
      const entryW = swatch + pad + textW;
      // Move to a new row once an entry would spill past the figure width, but
      // always keep at least one entry per row so a lone wide label still fits.
      if (x > figMinX && x + entryW > rightEdge) {
        x = figMinX;
        y += rowStride;
      }
      entries.push({
        x,
        y: y - swatch / 2,
        size: swatch,
        colour: item.colour,
        label: item.label,
        textX: x + swatch + pad,
        textY: y,
      });
      acc(x, y - swatch / 2);
      acc(x + entryW, y + swatch / 2);
      x += entryW + entryGap;
    }
    legend = { entries, fontSize: cfg.legendFontSize };
  }

  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }

  return { genes, loci, clusters: clusterBoxes, labels, links, scaleBar, legend, bounds: { minX, minY, maxX, maxY } };
}

/**
 * Compute per-cluster horizontal offsets that align every cluster's homolog of
 * `geneUid` to the same world X as the clicked gene ("centering").
 *
 * Homology heuristic: prefer the explicit homology group that contains the
 * clicked gene (robust regardless of the active colour mode, since groups are
 * the canonical notion of homology). If the gene belongs to no group, fall back
 * to the homology `links` touching it (the other endpoints are its homologs).
 *
 * Representative choice when a cluster has several homologs: pick the gene with
 * the strongest homology link to the clicked gene (by the active metric); break
 * ties — and handle the no-link case — by proximity to the anchor so the cluster
 * moves the least.
 *
 * Overlap note: offsets are derived from the CURRENT scene geometry (positions
 * already include existing offsets AND any preventOverlap resolution), and the
 * returned offset is `existingOffset + (anchorX - homologCenterX)`. For the
 * common single-cluster-per-lane case, overlap resolution is a no-op, so the
 * homolog lands exactly on the anchor after re-render. In multi-cluster lanes
 * overlap resolution may nudge clusters, so alignment there is best-effort.
 *
 * Returns the SAME `currentOffsets` reference (a no-op) when the gene isn't in
 * the scene or has no homologs in other clusters.
 */
export function computeCenteringOffsets(
  scene: Scene,
  data: FigureData,
  geneUid: string,
  currentOffsets: Record<string, number>,
  metric: MetricKey,
): Record<string, number> {
  const shapeByUid = new Map(scene.genes.map((g) => [g.uid, g] as const));
  const anchor = shapeByUid.get(geneUid);
  if (!anchor) return currentOffsets;
  const anchorX = (anchor.x0 + anchor.x1) / 2;
  const anchorClusterUid = data.clusters[anchor.cluster]?.uid;

  // Homology set: explicit group first, else links touching the clicked gene.
  let homologUids: Set<string>;
  const group = data.groups.find((g) => g.genes.includes(geneUid));
  if (group) {
    homologUids = new Set(group.genes);
  } else {
    homologUids = new Set<string>();
    for (const link of data.links) {
      if (link.query === geneUid) homologUids.add(link.target);
      else if (link.target === geneUid) homologUids.add(link.query);
    }
  }
  homologUids.delete(geneUid);
  if (homologUids.size === 0) return currentOffsets;

  // Strength of the direct homology link from the clicked gene to each homolog,
  // by the active metric, used to pick a per-cluster representative.
  const linkStrength = new Map<string, number>();
  for (const link of data.links) {
    let other: string | null = null;
    if (link.query === geneUid) other = link.target;
    else if (link.target === geneUid) other = link.query;
    if (other && homologUids.has(other)) {
      const v = link.metrics[metric];
      const s = typeof v === "number" ? v : 0;
      linkStrength.set(other, Math.max(linkStrength.get(other) ?? 0, s));
    }
  }

  // Bucket candidate homolog shapes by cluster (offsets are per-cluster). Skip
  // the clicked gene's own cluster: it is the anchor and stays put.
  const byCluster = new Map<string, GeneShape[]>();
  for (const g of scene.genes) {
    if (!homologUids.has(g.uid)) continue;
    const uid = data.clusters[g.cluster]?.uid;
    if (!uid || uid === anchorClusterUid) continue;
    const arr = byCluster.get(uid);
    if (arr) arr.push(g);
    else byCluster.set(uid, [g]);
  }
  if (byCluster.size === 0) return currentOffsets;

  const next: Record<string, number> = { ...currentOffsets };
  for (const [uid, candidates] of byCluster) {
    let best = candidates[0];
    let bestStrength = linkStrength.get(best.uid) ?? 0;
    let bestDist = Math.abs((best.x0 + best.x1) / 2 - anchorX);
    for (let i = 1; i < candidates.length; i++) {
      const g = candidates[i];
      const strength = linkStrength.get(g.uid) ?? 0;
      const dist = Math.abs((g.x0 + g.x1) / 2 - anchorX);
      if (strength > bestStrength || (strength === bestStrength && dist < bestDist)) {
        best = g;
        bestStrength = strength;
        bestDist = dist;
      }
    }
    const homologCenterX = (best.x0 + best.x1) / 2;
    next[uid] = (currentOffsets[uid] ?? 0) + (anchorX - homologCenterX);
  }
  return next;
}
