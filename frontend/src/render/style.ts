import type { GeneShapeKind, LayoutConfig } from "./layout";

// Internal spacing between loci within a single cluster (px). Previously a
// user-facing "Locus spacing" control; kept as a fixed sensible default.
const LOCUS_GAP = 24;

/** User-tunable figure style (SPEC §10). */
export interface StyleConfig {
  // Arrangement
  pxPerKb: number;
  clusterSpacing: number;
  /** When true, clusters dragged along their row cannot overlap their neighbours. */
  preventOverlap: boolean;
  // CDS glyphs
  geneShape: GeneShapeKind;
  trackHeight: number;
  tipLength: number;
  geneStroke: string;
  geneStrokeWidth: number;
  // Backbone (sequence line)
  backboneColour: string;
  backboneWidth: number;
  backboneOpacity: number;
  // Labels
  showClusterNames: boolean;
  clusterFontSize: number;
  // Links
  showLinks: boolean;
  straightLinks: boolean;
  /** Colour ribbons by their genes' shared colour (vs. a neutral grey). */
  colourLinks: boolean;
  /** Show the active similarity metric's value between connected genes. */
  showLinkLabels: boolean;
  /** Narrow each ribbon to its link's aligned sub-region (partial-similarity mode)
   * instead of spanning the whole gene; falls back to full extent when a link has
   * no aligned span (e.g. DIAMOND or global-alignment links). */
  anchorLinksToAligned: boolean;
  linkOpacity: number;
  linkThreshold: number;
  /** Minimum shared aligned-region length (residues) for a partial-similarity
   * link to be shown; 0 = off. Applies only to parasail-local links. */
  minFragmentAa: number;
  // Figure key (drawn below the tracks; both independently togglable)
  showScaleBar: boolean;
  scaleFontSize: number;
  /** Fixed scale-bar length in kb; 0 auto-picks a round value from the zoom. */
  scaleBarKb: number;
  /** Scale-bar line thickness (world units). */
  scaleBarThickness: number;
  showLegend: boolean;
  legendFontSize: number;
  /** Horizontal gap between legend entries (world units). */
  legendSpacing: number;
  /** Cap the legend at this many colours; extra categories collapse into a grey
   * "Other" row. 0 = show every category. */
  maxLegendEntries: number;
  // Canvas
  background: string;
}

export const DEFAULT_STYLE: StyleConfig = {
  pxPerKb: 50,
  clusterSpacing: 54,
  preventOverlap: true,
  geneShape: "triangle",
  trackHeight: 16,
  tipLength: 14,
  geneStroke: "#33383f",
  geneStrokeWidth: 0.7,
  backboneColour: "#c2c7ce",
  backboneWidth: 1,
  backboneOpacity: 1,
  showClusterNames: true,
  clusterFontSize: 13,
  showLinks: true,
  straightLinks: false,
  colourLinks: true,
  showLinkLabels: false,
  anchorLinksToAligned: true,
  linkOpacity: 1,
  linkThreshold: 0,
  minFragmentAa: 0,
  showScaleBar: true,
  scaleFontSize: 13,
  scaleBarKb: 0,
  scaleBarThickness: 1.5,
  showLegend: true,
  legendFontSize: 13,
  legendSpacing: 18,
  maxLegendEntries: 10,
  background: "#ffffff",
};

/** Build the full render config consumed by layout + draw + svg. */
export function makeConfig(style: StyleConfig): LayoutConfig {
  return {
    pxPerBp: style.pxPerKb / 1000,
    trackHeight: style.trackHeight,
    rowGap: style.clusterSpacing,
    locusGap: LOCUS_GAP,
    colGap: 64,
    preventOverlap: style.preventOverlap,
    labelGap: 18,
    tipLength: style.tipLength,
    geneShape: style.geneShape,
    geneStroke: style.geneStroke,
    geneStrokeWidth: style.geneStrokeWidth,
    showClusterNames: style.showClusterNames,
    clusterFontSize: style.clusterFontSize,
    showLinks: style.showLinks,
    straight: style.straightLinks,
    colourLinks: style.colourLinks,
    showLinkLabels: style.showLinkLabels,
    anchorLinksToAligned: style.anchorLinksToAligned,
    linkOpacity: style.linkOpacity,
    linkThreshold: style.linkThreshold,
    minFragmentAa: style.minFragmentAa,
    backboneColour: style.backboneColour,
    backboneWidth: style.backboneWidth,
    backboneOpacity: style.backboneOpacity,
    showScaleBar: style.showScaleBar,
    scaleFontSize: style.scaleFontSize,
    scaleBarBp: style.scaleBarKb * 1000,
    scaleBarThickness: style.scaleBarThickness,
    showLegend: style.showLegend,
    legendFontSize: style.legendFontSize,
    legendSpacing: style.legendSpacing,
    background: style.background,
  };
}
