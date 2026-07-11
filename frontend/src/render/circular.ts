import type {
  ClusterBox,
  ClusterLabel,
  GeneShape,
  LayoutConfig,
  LinkRibbon,
  LocusLine,
  Scene,
} from "./layout";

// A Circos-style circular view built by re-projecting the linear scene into polar
// space, so buildScene (and every linear code path) stays untouched. Lanes become
// concentric rings; base-pairs map to angle via one global scale (so a wider row
// fills more of the circle); each cluster carries an angular rotation offset. Genes
// become annular wedges, backbones arcs, and homology links centre-pulled chords —
// all emitted as the optional `points`/`arc`/`path` fields the renderers already
// honour, so the same Canvas + SVG renderers draw either mode.

const CENTRE_X = 0;
const CENTRE_Y = 0;
const ANGLE_SPAN = Math.PI * 1.9; // leave a small gap so the ring ends read apart
const START_ANGLE = -Math.PI / 2; // 12 o'clock; angle increases clockwise (y-down)

function polar(r: number, a: number): [number, number] {
  return [CENTRE_X + r * Math.cos(a), CENTRE_Y + r * Math.sin(a)];
}

/** Sample an arc at radius `r` from `a0` to `a1` into world points (inclusive). */
function arcPoints(r: number, a0: number, a1: number): Array<[number, number]> {
  const steps = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 0.08));
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) pts.push(polar(r, a0 + ((a1 - a0) * i) / steps));
  return pts;
}

export function toCircular(
  scene: Scene,
  cfg: LayoutConfig,
  clusterAngles: Record<string, number>,
  clusterUidByIndex: string[],
): Scene {
  const th = cfg.trackHeight / 2;
  const ringGap = cfg.trackHeight + 30;

  // Content extent in linear world x (genes + loci), and the set of lane baselines.
  let minX = Infinity, maxX = -Infinity;
  const laneYs = new Set<number>();
  for (const g of scene.genes) {
    minX = Math.min(minX, g.x0, g.x1);
    maxX = Math.max(maxX, g.x0, g.x1);
    laneYs.add(g.y);
  }
  for (const lo of scene.loci) {
    minX = Math.min(minX, lo.x0, lo.x1);
    maxX = Math.max(maxX, lo.x0, lo.x1);
    laneYs.add(lo.y);
  }
  if (!isFinite(minX)) return scene; // nothing to place
  const contentW = Math.max(1, maxX - minX);
  const k = ANGLE_SPAN / contentW; // radians per world-x, shared by all rings

  const ys = [...laneYs].sort((a, b) => a - b);
  const R0 = Math.max(150, ringGap * 1.5);
  const radiusForY = (y: number) => R0 + ys.indexOf(y) * ringGap;
  const angleForX = (x: number) => START_ANGLE + (x - minX) * k;

  const rotForCluster = (uid: string) => clusterAngles[uid] ?? 0;
  const rotForGene = (g: GeneShape) => rotForCluster(clusterUidByIndex[g.cluster] ?? "");

  // Genes → annular wedges.
  const geneByUid = new Map<string, GeneShape>();
  const genes: GeneShape[] = scene.genes.map((g) => {
    const rot = rotForGene(g);
    const r = radiusForY(g.y);
    const aLo = angleForX(g.x0) + rot;
    const aHi = angleForX(g.x1) + rot;
    const headed = g.strand !== 0 && cfg.geneShape !== "box" && cfg.geneShape !== "rounded";
    const headLen = Math.min(aHi - aLo, cfg.tipLength * k);
    let points: Array<[number, number]>;
    if (!headed || headLen <= 0) {
      // Plain annular sector.
      points = [...arcPoints(r + th, aLo, aHi), ...arcPoints(r - th, aHi, aLo)];
    } else if (g.strand >= 0) {
      // Forward: head at the high-angle (x1) end, tip on the centreline.
      const aBody = aHi - headLen;
      points = [...arcPoints(r + th, aLo, aBody), polar(r, aHi), ...arcPoints(r - th, aBody, aLo)];
    } else {
      // Reverse: head at the low-angle (x0) end.
      const aBody = aLo + headLen;
      points = [...arcPoints(r + th, aHi, aBody), polar(r, aLo), ...arcPoints(r - th, aBody, aHi)];
    }
    // Label anchor: just outside the wedge at its mid-angle, with the arc length as
    // the available width (so narrow wedges truncate).
    const aMid = (aLo + aHi) / 2;
    const [lx, ly] = polar(r + th + 3, aMid);
    const out: GeneShape = { ...g, points, labelAnchor: { x: lx, y: ly, w: r * (aHi - aLo) } };
    geneByUid.set(g.uid, out);
    return out;
  });

  // Backbones → arcs.
  const loci: LocusLine[] = scene.loci.map((lo) => {
    const rot = lo.cluster != null ? rotForCluster(clusterUidByIndex[lo.cluster] ?? "") : 0;
    const r = radiusForY(lo.y);
    const a0 = angleForX(lo.x0) + rot;
    const a1 = angleForX(lo.x1) + rot;
    return { ...lo, arc: { cx: CENTRE_X, cy: CENTRE_Y, r, a0, a1 } };
  });

  // Cluster boxes gain ring/angle info for the rotate control.
  const clusterBoxByUid = new Map<string, ClusterBox>();
  const clusters: ClusterBox[] = scene.clusters.map((b) => {
    const rot = rotForCluster(b.uid);
    const r = radiusForY(b.trackY);
    const aMid = angleForX((b.x0 + b.x1) / 2) + rot;
    const out: ClusterBox = { ...b, circular: { cx: CENTRE_X, cy: CENTRE_Y, r, aMid } };
    clusterBoxByUid.set(b.uid, out);
    return out;
  });

  // Cluster labels ride just outside their ring at the cluster's mid-angle.
  const labels: ClusterLabel[] = scene.labels.map((lab) => {
    const boxes = lab.members.map((m) => clusterBoxByUid.get(m)).filter(Boolean) as ClusterBox[];
    if (!boxes.length || !boxes[0].circular) return lab;
    const aMid = boxes.reduce((s, b) => s + (b.circular?.aMid ?? 0), 0) / boxes.length;
    const r = Math.max(...boxes.map((b) => b.circular?.r ?? R0)) + th + 10;
    const [x, y] = polar(r, aMid);
    return { ...lab, x, y, align: "left" as const, middle: true };
  });

  // Links → centre-pulled chords between two rings.
  const links: LinkRibbon[] = scene.links.map((l) => {
    const q = geneByUid.get(l.link.query);
    const t = geneByUid.get(l.link.target);
    // Which endpoint sits on the ay ring (the ribbon's "upper").
    const top = q && Math.abs(q.y - l.ay) < 1e-6 ? q : t;
    const bot = top === q ? t : q;
    const rotTop = top ? rotForGene(top) : 0;
    const rotBot = bot ? rotForGene(bot) : 0;
    const rTop = radiusForY(l.ay);
    const rBot = radiusForY(l.by);
    const aT0 = angleForX(l.ax0) + rotTop;
    const aT1 = angleForX(l.ax1) + rotTop;
    const aB0 = angleForX(l.bx0) + rotBot;
    const aB1 = angleForX(l.bx1) + rotBot;
    const seg = (pts: Array<[number, number]>, cmd: "M" | "L") =>
      pts.map((p, i) => `${i === 0 ? cmd : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
    const [bx1, by1] = polar(rBot, aB1);
    const [tx0, ty0] = polar(rTop, aT0);
    const path =
      seg(arcPoints(rTop, aT0, aT1), "M") +
      `Q${CENTRE_X},${CENTRE_Y} ${bx1.toFixed(1)},${by1.toFixed(1)}` +
      seg(arcPoints(rBot, aB1, aB0), "L") +
      `Q${CENTRE_X},${CENTRE_Y} ${tx0.toFixed(1)},${ty0.toFixed(1)}Z`;
    const [mx, my] = polar((rTop + rBot) / 2, (aT0 + aT1 + aB0 + aB1) / 4);
    return { ...l, path, mx, my };
  });

  // Bounds: a square around the outer ring (plus label room), unioned with the
  // scale bar / legend so nothing the renderer draws is clipped.
  const Rmax = R0 + (ys.length - 1) * ringGap + th + 48;
  let bMinX = -Rmax, bMaxX = Rmax, bMinY = -Rmax, bMaxY = Rmax;
  const acc = (x: number, y: number) => {
    bMinX = Math.min(bMinX, x); bMaxX = Math.max(bMaxX, x);
    bMinY = Math.min(bMinY, y); bMaxY = Math.max(bMaxY, y);
  };
  for (const lab of labels) acc(lab.x, lab.y);
  if (scene.scaleBar) { acc(scene.scaleBar.x0, scene.scaleBar.y); acc(scene.scaleBar.x1, scene.scaleBar.labelY); }
  if (scene.legend) for (const e of scene.legend.entries) acc(e.x, e.y);

  return {
    ...scene,
    genes,
    loci,
    clusters,
    labels,
    links,
    bounds: { minX: bMinX, minY: bMinY, maxX: bMaxX, maxY: bMaxY },
  };
}
