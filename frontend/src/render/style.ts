import type { ClusterLabelPlacement, ClusterLabelSide, GeneLabelMode, GeneLabelPosition, GeneLabelScope, GeneShapeKind, LayoutConfig } from "./layout";

// Internal spacing between loci within a single cluster (px). Previously a
// user-facing "Locus spacing" control; kept as a fixed sensible default.
const LOCUS_GAP = 24;

/** User-tunable figure style. */
export interface StyleConfig {
  // Arrangement
  pxPerKb: number;
  clusterSpacing: number;
  /** Apply the per-row extra spacing (clusterSpaceAbove) on top of `clusterSpacing`.
   * Off keeps rows evenly spaced without forgetting the per-row values. */
  manualRowSpacing: boolean;
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
  // Cluster name labels
  showClusterNames: boolean;
  clusterFontSize: number;
  /** Above the sequence, or beside it (vertically centred on the track). */
  clusterLabelPlacement: ClusterLabelPlacement;
  /** Which end of the cluster the name sits at. */
  clusterLabelSide: ClusterLabelSide;
  /** Pin names to the canvas edge (stationary) instead of moving with the sequence. */
  clusterLabelPinned: boolean;
  // CDS (gene) labels
  /** never / always / auto (auto reveals labels only once a gene is wide enough). */
  showGeneLabels: GeneLabelMode;
  /** Qualifier key to label genes by; "" uses the gene→locus_tag→protein_id fallback. */
  geneLabelField: string;
  /** Label every gene, or only custom-group members. */
  geneLabelScope: GeneLabelScope;
  geneLabelFontSize: number;
  /** Above the arrow, or centred on it. */
  geneLabelPosition: GeneLabelPosition;
  /** Label rotation in degrees (0 = horizontal). */
  geneLabelRotation: number;
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
  manualRowSpacing: false,
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
  clusterLabelPlacement: "above",
  clusterLabelSide: "left",
  clusterLabelPinned: false,
  showGeneLabels: "never",
  geneLabelField: "",
  geneLabelScope: "all",
  geneLabelFontSize: 11,
  geneLabelPosition: "above",
  geneLabelRotation: 0,
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
    manualRowSpacing: style.manualRowSpacing,
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
    clusterLabelPlacement: style.clusterLabelPlacement,
    clusterLabelSide: style.clusterLabelSide,
    // "Beside" only makes sense pinned: a per-cluster name placed next to its own
    // sequence lands on top of the neighbouring cluster whenever a row holds more
    // than one. Normalising here means every consumer sees one coherent state.
    clusterLabelPinned: style.clusterLabelPinned || style.clusterLabelPlacement === "beside",
    showGeneLabels: style.showGeneLabels,
    geneLabelFontSize: style.geneLabelFontSize,
    geneLabelField: style.geneLabelField,
    geneLabelPosition: style.geneLabelPosition,
    geneLabelRotation: style.geneLabelRotation,
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
