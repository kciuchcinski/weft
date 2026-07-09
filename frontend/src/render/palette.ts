import type { FigureData } from "../types";

// Named categorical palettes (SPEC §8). These are the widely-used qualitative
// palettes from Tableau, D3/matplotlib, ColorBrewer, and Okabe–Ito. Okabe–Ito,
// Tableau 10, and Dark2 are the most colourblind-friendly choices.
export const PALETTES: Record<string, string[]> = {
  "Tableau 10": ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC"],
  "Category 10": ["#1F77B4", "#FF7F0E", "#2CA02C", "#D62728", "#9467BD", "#8C564B", "#E377C2", "#7F7F7F", "#BCBD22", "#17BECF"],
  "Category 20": ["#1F77B4", "#AEC7E8", "#FF7F0E", "#FFBB78", "#2CA02C", "#98DF8A", "#D62728", "#FF9896", "#9467BD", "#C5B0D5", "#8C564B", "#C49C94", "#E377C2", "#F7B6D2", "#7F7F7F", "#C7C7C7", "#BCBD22", "#DBDB8D", "#17BECF", "#9EDAE5"],
  "Okabe–Ito": ["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7", "#999999"],
  "Set1": ["#E41A1C", "#377EB8", "#4DAF4A", "#984EA3", "#FF7F00", "#FFFF33", "#A65628", "#F781BF", "#999999"],
  "Set2": ["#66C2A5", "#FC8D62", "#8DA0CB", "#E78AC3", "#A6D854", "#FFD92F", "#E5C494", "#B3B3B3"],
  "Set3": ["#8DD3C7", "#FFFFB3", "#BEBADA", "#FB8072", "#80B1D3", "#FDB462", "#B3DE69", "#FCCDE5", "#D9D9D9", "#BC80BD", "#CCEBC5", "#FFED6F"],
  "Dark2": ["#1B9E77", "#D95F02", "#7570B3", "#E7298A", "#66A61E", "#E6AB02", "#A6761D", "#666666"],
  "Pastel1": ["#FBB4AE", "#B3CDE3", "#CCEBC5", "#DECBE4", "#FED9A6", "#FFFFCC", "#E5D8BD", "#FDDAEC", "#F2F2F2"],
  "Accent": ["#7FC97F", "#BEAED4", "#FDC086", "#FFFF99", "#386CB0", "#F0027F", "#BF5B17", "#666666"],
  "Paired": ["#A6CEE3", "#1F78B4", "#B2DF8A", "#33A02C", "#FB9A99", "#E31A1C", "#FDBF6F", "#FF7F00", "#CAB2D6", "#6A3D9A", "#B15928"],
};

export const PALETTE_NAMES = Object.keys(PALETTES);
export const DEFAULT_PALETTE = "Tableau 10";
export const UNGROUPED = "#cbd0d6";

/** Legend id of the collapsed "Other" row produced when capping entries. */
export const OTHER_ID = "__other__";

export type ColourBy = "group" | "cluster" | "field" | "custom";

/** A user-defined colour group: hand-picked genes that share one colour. */
export interface CustomGroup {
  id: string;
  label: string;
  colour: string;
  genes: string[]; // gene uids
}

export interface LegendItem {
  id: string;
  label: string;
  colour: string;
  count: number;
}

export interface ColourResult {
  gene: Map<string, string>; // gene uid -> colour
  items: LegendItem[]; // legend rows for the active target
}

/** One colour category before the legend is (optionally) capped. */
interface Bucket {
  id: string;
  label: string;
  colour: string;
  geneUids: string[];
}

/**
 * Turn colour buckets into the gene→colour map and legend rows, optionally
 * capping the legend: when `maxEntries > 0` and there are more buckets than
 * that, only the `maxEntries` largest (by gene count) keep their colour and the
 * remainder collapse into a single grey "Other" row. This keeps long-tailed
 * annotations (e.g. hundreds of distinct products) from producing a legend with
 * more entries than colours in the palette.
 */
function finalizeColours(buckets: Bucket[], maxEntries: number): ColourResult {
  let keep: Set<string> | null = null;
  if (maxEntries > 0 && buckets.length > maxEntries) {
    // Rank by gene count; sort is stable so ties keep first-appearance order.
    const ranked = [...buckets].sort((a, b) => b.geneUids.length - a.geneUids.length);
    keep = new Set(ranked.slice(0, maxEntries).map((b) => b.id));
  }

  const gene = new Map<string, string>();
  const items: LegendItem[] = [];
  let otherCount = 0;
  let otherGroups = 0;
  // Iterate in original order: preserves palette stability and "last write wins"
  // for genes shared by more than one bucket (overlapping custom groups).
  for (const b of buckets) {
    const kept = !keep || keep.has(b.id);
    const colour = kept ? b.colour : UNGROUPED;
    b.geneUids.forEach((uid) => gene.set(uid, colour));
    if (kept) {
      items.push({ id: b.id, label: b.label, colour, count: b.geneUids.length });
    } else {
      otherCount += b.geneUids.length;
      otherGroups += 1;
    }
  }
  if (otherGroups > 0) {
    items.push({ id: OTHER_ID, label: `Other (${otherGroups})`, colour: UNGROUPED, count: otherCount });
  }
  return { gene, items };
}

/** Override key for a GenBank-field value, namespaced so it never collides with
 * cluster/group uids or values from a different field. */
function fieldOverrideKey(field: string, value: string): string {
  return `field:${field}:${value}`;
}

/** All distinct GenBank/GFF qualifier keys present on any gene, sorted. Used to
 * populate the "colour by field" selector (e.g. product, function, gene). */
export function availableFields(data: FigureData): string[] {
  const keys = new Set<string>();
  for (const c of data.clusters)
    for (const l of c.loci)
      for (const g of l.genes)
        for (const k of Object.keys(g.names)) keys.add(k);
  return [...keys].sort();
}

/**
 * Resolve colours for the active target, applying the chosen palette and any
 * manual per-item overrides. Targets:
 *  - "group"   → one colour per homology group (keyed by group uid)
 *  - "cluster" → one colour per cluster (keyed by cluster uid)
 *  - "field"   → one colour per distinct value of `colourField` in gene.names
 *  - "custom"  → user-defined groups, each carrying its own colour
 */
export function computeColours(
  data: FigureData,
  colourBy: ColourBy,
  paletteName: string,
  overrides: Record<string, string>,
  colourField?: string,
  customGroups: CustomGroup[] = [],
  maxEntries = 0,
): ColourResult {
  const palette = PALETTES[paletteName] ?? PALETTES[DEFAULT_PALETTE];
  const buckets: Bucket[] = [];

  if (colourBy === "cluster") {
    data.clusters.forEach((c, i) => {
      const geneUids: string[] = [];
      c.loci.forEach((l) => l.genes.forEach((g) => geneUids.push(g.uid)));
      buckets.push({ id: c.uid, label: c.name, colour: overrides[c.uid] ?? palette[i % palette.length], geneUids });
    });
  } else if (colourBy === "field") {
    // Bucket genes by the chosen qualifier value; genes lacking the field stay
    // uncoloured (fall through to UNGROUPED at draw time). Values are ordered by
    // first appearance so palette assignment is stable across renders.
    const field = colourField ?? "";
    const order: string[] = [];
    const uidsByValue = new Map<string, string[]>();
    data.clusters.forEach((c) => c.loci.forEach((l) => l.genes.forEach((g) => {
      const value = g.names[field];
      if (value == null || value === "") return;
      let uids = uidsByValue.get(value);
      if (!uids) { uids = []; uidsByValue.set(value, uids); order.push(value); }
      uids.push(g.uid);
    })));
    order.forEach((value, i) => buckets.push({
      id: fieldOverrideKey(field, value),
      label: value,
      colour: overrides[fieldOverrideKey(field, value)] ?? palette[i % palette.length],
      geneUids: uidsByValue.get(value)!,
    }));
  } else if (colourBy === "custom") {
    customGroups.forEach((grp) => buckets.push({
      id: grp.id, label: grp.label, colour: grp.colour, geneUids: grp.genes,
    }));
  } else {
    data.groups.forEach((grp, i) => buckets.push({
      id: grp.uid,
      label: grp.label,
      colour: overrides[grp.uid] ?? palette[i % palette.length],
      geneUids: grp.genes,
    }));
  }

  return finalizeColours(buckets, maxEntries);
}
