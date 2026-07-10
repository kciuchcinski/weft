import type { FigureData, MetricKey } from "./types";
import { buildScene } from "./render/layout";
import { computeColours, type ColourBy, type CustomGroup } from "./render/palette";
import { makeConfig, type StyleConfig } from "./render/style";
import { sceneToSVG } from "./render/svg";
import { draw } from "./render/draw";
import { download } from "./download";

export interface FigureState {
  data: FigureData | null;
  lanes: string[][];
  clusterOffsets: Record<string, number>;
  activeMetric: MetricKey;
  colourBy: ColourBy;
  paletteName: string;
  overrides: Record<string, string>;
  colourField: string;
  customGroups: CustomGroup[];
  style: StyleConfig;
}

function sceneFrom(s: FigureState) {
  const cfg = makeConfig(s.style);
  const colours = computeColours(s.data!, s.colourBy, s.paletteName, s.overrides, s.colourField, s.customGroups, s.style.maxLegendEntries);
  return {
    cfg,
    scene: buildScene(s.data!, s.lanes, cfg, colours.gene, s.activeMetric, s.clusterOffsets, undefined, colours.items),
  };
}

export function exportSVG(s: FigureState): void {
  if (!s.data) return;
  const { cfg, scene } = sceneFrom(s);
  download(new Blob([sceneToSVG(scene, cfg)], { type: "image/svg+xml" }), "weft.svg");
}

export function exportPNG(s: FigureState, scale = 2): void {
  if (!s.data) return;
  const { cfg, scene } = sceneFrom(s);
  const m = 24;
  const b = scene.bounds;
  const w = Math.max(1, Math.ceil((b.maxX - b.minX + 2 * m) * scale));
  const h = Math.max(1, Math.ceil((b.maxY - b.minY + 2 * m) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  draw(
    ctx,
    scene,
    { dpr: 1, cssW: w, cssH: h, zoom: scale, panX: (m - b.minX) * scale, panY: (m - b.minY) * scale },
    cfg,
  );
  canvas.toBlob((blob) => { if (blob) download(blob, "weft.png"); });
}

export function exportAlignmentTableCSV(s: FigureState): void {
  if (!s.data) return;
  const rows = [
    "query,target,identity,similarity,coverage,bitscore,evalue",
    ...s.data.links.map((l) =>
      [
        l.query,
        l.target,
        l.metrics.identity ?? "",
        l.metrics.similarity ?? "",
        l.metrics.coverage ?? "",
        l.metrics.bitscore ?? "",
        l.metrics.evalue ?? "",
      ].join(",")
    ),
  ];
  download(new Blob([rows.join("\n")], { type: "text/csv" }), "weft-alignment-table.csv");
}

export function exportSimilarityMatrixCSV(s: FigureState): void {
  if (!s.data) return;
  const clusterByGene = new Map<string, string>();
  for (const c of s.data.clusters) {
    for (const l of c.loci) {
      for (const g of l.genes) clusterByGene.set(g.uid, c.name);
    }
  }
  const names = s.data.clusters.map((c) => c.name);
  const matrix = new Map<string, number>();
  for (const a of names) for (const b of names) matrix.set(`${a}\t${b}`, 0);
  for (const link of s.data.links) {
    const a = clusterByGene.get(link.query);
    const b = clusterByGene.get(link.target);
    if (!a || !b || a === b) continue;
    matrix.set(`${a}\t${b}`, (matrix.get(`${a}\t${b}`) ?? 0) + 1);
    matrix.set(`${b}\t${a}`, (matrix.get(`${b}\t${a}`) ?? 0) + 1);
  }
  const lines: string[] = [];
  lines.push(["cluster", ...names].join(","));
  for (const row of names) {
    lines.push([row, ...names.map((col) => String(matrix.get(`${row}\t${col}`) ?? 0))].join(","));
  }
  download(new Blob([lines.join("\n")], { type: "text/csv" }), "weft-similarity-matrix.csv");
}
