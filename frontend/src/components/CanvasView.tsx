import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore, type MoveTarget } from "../state/store";
import { computeColours, hiddenGeneUids } from "../render/palette";
import { buildScene, formatMetric, qualifierEntries, type Scene } from "../render/layout";
import { geneLabelEligible as geneLabelEligibleFor, labelScreenRect, measureLabel } from "../render/labels";
import { makeConfig } from "../render/style";
import { draw, type Highlight } from "../render/draw";
import { ribbonPath } from "../render/geometry";
import CanvasWelcome from "./CanvasWelcome";
import GeneInspector from "./GeneInspector";
import type { Gene, Link, MetricKey } from "../types";

// Display names for link metrics in the ribbon hover tooltip.
const METRIC_LABELS: Record<string, string> = {
  identity: "Identity",
  similarity: "Similarity",
  coverage: "Coverage",
  bitscore: "Bit score",
  evalue: "E-value",
  jaccard: "Jaccard",
};

interface ClusterCtl {
  uid: string;
  name: string;
  lane: number;
  reversed: boolean;
  /** True when the pill hangs off the cluster's left edge (so it anchors right). */
  atLeft: boolean;
  left: number; // screen x of the pill's anchor edge, just outside the cluster
  centerY: number; // screen y of the track baseline (drag/drop truth)
  renderY: number; // screen y used to place the control (de-collided)
  centerX: number; // screen x of the cluster's horizontal centre
}

// Label geometry lives in render/labels.ts so the renderer, hit-testing, the drag
// handle and the rename editor all place names identically.

interface DropTarget {
  kind: "join" | "new";
  y: number;
  height: number;
  x?: number;
}

type LabelEdit = {
  /** A cluster uid, or a merged row's key. `kind` says which. */
  id: string;
  kind: "cluster" | "row";
  value: string;
  left: number;
  top: number;
  width: number;
  fontSize: number;
};

// Controls anchored at each cluster's left edge collapse into a single left
// column at fit-zoom (every lane's leading cluster starts near x=0), so they
// stack on top of each other. Nudge only their *display* Y (renderY) apart when
// they share a column; centerY stays the true baseline used for drag/drop.
function decollideCtls(ctls: ClusterCtl[]): void {
  const MIN_GAP = 27; // approx control height + a little breathing room
  const COL_TOL = 44; // controls within this horizontal distance count as one column
  const cols = new Map<number, ClusterCtl[]>();
  for (const c of ctls) {
    const key = Math.round(c.left / COL_TOL);
    const bucket = cols.get(key);
    if (bucket) bucket.push(c);
    else cols.set(key, [c]);
  }
  for (const group of cols.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.centerY - b.centerY);
    for (let i = 1; i < group.length; i++) {
      const minY = group[i - 1].renderY + MIN_GAP;
      if (group[i].renderY < minY) group[i].renderY = minY;
    }
  }
}

function sameCtls(a: ClusterCtl[], b: ClusterCtl[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = b[i];
    if (
      p.uid !== q.uid ||
      p.lane !== q.lane ||
      p.reversed !== q.reversed ||
      Math.abs(p.left - q.left) > 0.5 ||
      Math.abs(p.centerY - q.centerY) > 0.5 ||
      Math.abs(p.renderY - q.renderY) > 0.5 ||
      Math.abs(p.centerX - q.centerX) > 0.5
    ) {
      return false;
    }
  }
  return true;
}

// Hover tooltip anchored just below-right of the cursor, flipped to the cursor's
// left / above when that would run past the canvas edge. Positioned in a layout
// effect (after measuring, before paint) so it never flashes at the clipped spot.
const TIP_OFFSET = 14;
const TIP_MARGIN = 8;
function FloatingTip({ sx, sy, children }: { sx: number; sy: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.offsetParent as HTMLElement | null;
    if (!el || !box) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = sx + TIP_OFFSET;
    if (left + w > box.clientWidth - TIP_MARGIN) left = sx - TIP_OFFSET - w;
    let top = sy + TIP_OFFSET;
    if (top + h > box.clientHeight - TIP_MARGIN) top = sy - TIP_OFFSET - h;
    el.style.left = `${Math.max(TIP_MARGIN, left)}px`;
    el.style.top = `${Math.max(TIP_MARGIN, top)}px`;
  });
  return (
    <div ref={ref} className="gene-tooltip" style={{ left: sx + TIP_OFFSET, top: sy + TIP_OFFSET }}>
      {children}
    </div>
  );
}

export default function CanvasView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const data = useStore((s) => s.data);
  const lanes = useStore((s) => s.lanes);
  const clusterOffsets = useStore((s) => s.clusterOffsets);
  const circularClusters = useStore((s) => s.circularClusters);
  const clusterRotation = useStore((s) => s.clusterRotation);
  const clusterSpaceAbove = useStore((s) => s.clusterSpaceAbove);
  const hiddenClusters = useStore((s) => s.hiddenClusters);
  const activeMetric = useStore((s) => s.activeMetric);
  const colourBy = useStore((s) => s.colourBy);
  const paletteName = useStore((s) => s.paletteName);
  const overrides = useStore((s) => s.overrides);
  const colourField = useStore((s) => s.colourField);
  const customGroups = useStore((s) => s.customGroups);
  const activeCustomGroup = useStore((s) => s.activeCustomGroup);
  const rowNames = useStore((s) => s.rowNames);
  const style = useStore((s) => s.style);

  const colours = useMemo(
    () =>
      data
        ? computeColours(data, colourBy, paletteName, overrides, colourField, customGroups, style.maxLegendEntries, hiddenGeneUids(data, hiddenClusters))
        : { gene: new Map<string, string>(), items: [] },
    [data, colourBy, paletteName, overrides, colourField, customGroups, style.maxLegendEntries, hiddenClusters]
  );

  const activeGroupLabel =
    colourBy === "custom" ? customGroups.find((g) => g.id === activeCustomGroup)?.label ?? null : null;
  const cfg = useMemo(() => makeConfig(style), [style]);

  // While sliding a cluster, it anchors overlap resolution (see buildScene) so it
  // tracks the cursor and neighbours part around it instead of it snapping across.
  const [hDraggingUid, setHDraggingUid] = useState<string | null>(null);

  const scene = useMemo<Scene | null>(
    () =>
      data
        ? buildScene(
            data,
            lanes,
            cfg,
            colours.gene,
            activeMetric,
            clusterOffsets,
            hDraggingUid ?? undefined,
            colours.items,
            rowNames,
            circularClusters,
            clusterRotation,
            hiddenClusters,
            clusterSpaceAbove,
            customGroups,
          )
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      data, lanes, clusterOffsets, colours, activeMetric, hDraggingUid, rowNames,
      circularClusters, clusterRotation, hiddenClusters, clusterSpaceAbove,
      style.pxPerKb, style.clusterSpacing, style.trackHeight,
      style.preventOverlap, style.manualRowSpacing, style.showLinks, style.linkThreshold, style.linkOpacity,
      style.anchorLinksToAligned, style.minFragmentAa,
      style.colourLinks, style.showLinkLabels, style.showScaleBar, style.showLegend,
      style.scaleFontSize, style.legendFontSize,
      style.scaleBarKb, style.scaleBarThickness, style.legendSpacing,
      // Cluster names participate in layout: their placement sets each label's world
      // anchor, and their drawn extent grows the bounds the SVG viewBox is cut from.
      style.showClusterNames, style.clusterFontSize,
      style.clusterLabelPlacement, style.clusterLabelSide, style.clusterLabelPinned,
      // Resolved into each gene's drawn label, so it changes the scene's text (custom
      // groups too, when labelling by group name).
      style.geneLabelField, customGroups,
    ]
  );

  const geneById = useMemo(() => {
    const m = new Map<string, Gene>();
    data?.clusters.forEach((c) => c.loci.forEach((l) => l.genes.forEach((g) => m.set(g.uid, g))));
    return m;
  }, [data]);

  // Ribbon hit-test paths (world coords), rebuilt with the scene. Tested against an
  // identity-transform context so the point and path share the same (world) space.
  const linkPaths = useMemo(
    () => (scene ? scene.links.map((l) => ({ link: l.link, path: new Path2D(ribbonPath(l, cfg.straight)) })) : []),
    [scene, cfg.straight]
  );
  const linkPathsRef = useRef(linkPaths);
  linkPathsRef.current = linkPaths;
  const hitCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  if (!hitCtxRef.current && typeof document !== "undefined") {
    hitCtxRef.current = document.createElement("canvas").getContext("2d");
  }

  // Which genes may carry a CDS label under the current scope (null = all genes).
  const geneLabelEligible = useMemo(
    () => (scene ? geneLabelEligibleFor(style.geneLabelScope, customGroups, scene.genes) : null),
    [style.geneLabelScope, customGroups, scene],
  );
  const geneLabelEligibleRef = useRef(geneLabelEligible);
  geneLabelEligibleRef.current = geneLabelEligible;

  // Link spotlit from the inspector's "Similar proteins" list: its endpoints plus
  // every member of their similarity groups.
  const highlightedLink = useStore((s) => s.highlightedLink);
  const selectedGene = useStore((s) => s.selectedGene);
  const highlight = useMemo<Highlight | null>(() => {
    const link = highlightedLink ? data?.links.find((l) => l.uid === highlightedLink) : undefined;
    if (!data || !link) return null;
    const origin = link.target === selectedGene ? link.target : link.query;
    const focus = origin === link.query ? link.target : link.query;
    const genes = new Set([origin, focus]);
    for (const g of data.groups) {
      if (g.genes.includes(origin) || g.genes.includes(focus)) g.genes.forEach((u) => genes.add(u));
    }
    return { link: link.uid, genes, focus, origin };
  }, [highlightedLink, selectedGene, data]);
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;

  const zoom = useRef(1);
  const pan = useRef({ x: 0, y: 0 });
  const sceneRef = useRef<Scene | null>(scene);
  sceneRef.current = scene;
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const [hover, setHover] = useState<{ gene: Gene; sx: number; sy: number } | null>(null);
  const [hoverLink, setHoverLink] = useState<{ link: Link; sx: number; sy: number } | null>(null);

  // Inline cluster-label (track name) editor, anchored over the label in screen space.
  const [editing, setEditing] = useState<LabelEdit | null>(null);
  // Mirror of the editing state so commit can read the latest value and guard the
  // Enter-then-blur double fire without running a store write inside a setState updater.
  const editingRef = useRef<LabelEdit | null>(null);
  editingRef.current = editing;

  // Per-cluster overlay controls (drag handle + reverse), positioned in screen space.
  const [ctls, setCtls] = useState<ClusterCtl[]>([]);
  const ctlsRef = useRef<ClusterCtl[]>(ctls);
  ctlsRef.current = ctls;
  const dragUid = useRef<string | null>(null);
  const pendingTarget = useRef<MoveTarget | null>(null);
  const [draggingUid, setDraggingUid] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  // Panning the view by dragging empty canvas. `moved` records whether the
  // gesture travelled far enough to count as a pan rather than a click — the
  // click/dblclick handlers check it so a drag never also selects a gene or
  // toggles custom-group membership.
  const panDrag = useRef({ active: false, startX: 0, startY: 0, panX: 0, panY: 0, moved: false });
  const PAN_SLOP = 4; // px of travel before a press becomes a pan

  // Horizontal component of a cluster drag: maps cursor X to a within-row offset.
  const hDragStartX = useRef(0); // screen x where the drag began
  const hDragStartOffset = useRef(0); // cluster offset (world px) at drag start
  const hDraggingRef = useRef(false);

  const syncCtls = () => {
    const s = sceneRef.current;
    if (!s) {
      if (ctlsRef.current.length) setCtls([]);
      return;
    }
    const z = zoom.current;
    const px = pan.current.x;
    const py = pan.current.y;
    const cfg = cfgRef.current;
    const fs = cfg.clusterFontSize;
    const atLeft = cfg.clusterLabelSide === "left";
    const reversedByUid = new Map<string, boolean>();
    const nameByUid = new Map<string, string>();
    useStore.getState().data?.clusters.forEach((c) => {
      reversedByUid.set(c.uid, !!c.reversed);
      nameByUid.set(c.uid, c.name);
    });
    // Pills are anchored to the *cluster*, never to its name: in pinned mode the
    // names share one column, so following them would pile every pill on the same
    // spot. Each pill sits in the band above its own sequence, just outside the
    // chosen end, so it can't collide with a name drawn inside that span.
    const PILL_GAP = 8;
    const next: ClusterCtl[] = s.clusters.map((box) => ({
      uid: box.uid,
      name: nameByUid.get(box.uid) ?? box.uid,
      lane: box.lane,
      reversed: !!reversedByUid.get(box.uid),
      atLeft,
      left: atLeft ? box.x0 * z + px - PILL_GAP : box.x1 * z + px + PILL_GAP,
      // Track row: the drag/drop truth (join zones align to the arrow row).
      centerY: box.trackY * z + py,
      // The band above the sequence, level with where an "above" name would sit.
      renderY: (box.trackY - cfg.trackHeight) * z + py - fs * 0.32,
      centerX: ((box.x0 + box.x1) / 2) * z + px,
    }));
    decollideCtls(next);
    if (!sameCtls(ctlsRef.current, next)) setCtls(next);
  };

  const render = () => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = wrap.clientWidth;
    const cssH = wrap.clientHeight;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (!sceneRef.current) {
      // No scene yet: clear the canvas and let the <CanvasWelcome> overlay carry
      // the empty state. Drawing text here would show through behind the card.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      syncCtls();
      return;
    }
    draw(ctx, sceneRef.current, { dpr, cssW, cssH, zoom: zoom.current, panX: pan.current.x, panY: pan.current.y }, cfgRef.current, geneLabelEligibleRef.current, highlightRef.current);
    syncCtls();
  };

  // Zoom by `factor`, keeping the world point under (cx, cy) pinned there. The
  // wheel passes the cursor so zoom follows what you're pointing at; the +/−
  // buttons pass the viewport centre.
  const zoomAt = (factor: number, cx: number, cy: number) => {
    const wx = (cx - pan.current.x) / zoom.current;
    const wy = (cy - pan.current.y) / zoom.current;
    zoom.current = Math.min(8, Math.max(0.05, zoom.current * factor));
    pan.current = { x: cx - wx * zoom.current, y: cy - wy * zoom.current };
    render();
  };

  // Slide the view by a screen-space delta.
  const panBy = (dx: number, dy: number) => {
    pan.current = { x: pan.current.x + dx, y: pan.current.y + dy };
    render();
  };

  // Fit + center the whole figure. The figure itself is stationary; only zoom changes it.
  const fit = () => {
    const wrap = wrapRef.current;
    const s = sceneRef.current;
    if (!wrap || !s) return;
    const cssW = wrap.clientWidth;
    const cssH = wrap.clientHeight;
    const bw = Math.max(1, s.bounds.maxX - s.bounds.minX);
    const bh = Math.max(1, s.bounds.maxY - s.bounds.minY);
    const cfg = cfgRef.current;
    const pad = 48;

    // Pinned names occupy a fixed-width column in *screen* space, so the room the
    // world bounds reserve for them shrinks as you zoom out and the figure slides
    // under the text. Reserve the column's true on-screen width on that side instead.
    let padL = pad;
    let padR = pad;
    if (cfg.showClusterNames && cfg.clusterLabelPinned && s.labels.length) {
      const colW = s.labels.reduce((m, l) => Math.max(m, measureLabel(l.name, cfg.clusterFontSize)), 0) + 2 * pad;
      if (cfg.clusterLabelSide === "left") padL = Math.max(padL, colW);
      else padR = Math.max(padR, colW);
    }

    const availW = Math.max(1, cssW - padL - padR);
    const z = Math.min(availW / bw, (cssH - 2 * pad) / bh, 4);
    zoom.current = z > 0 && isFinite(z) ? z : 1;
    pan.current = {
      x: padL + (availW - bw * zoom.current) / 2 - s.bounds.minX * zoom.current,
      y: (cssH - bh * zoom.current) / 2 - s.bounds.minY * zoom.current,
    };
    render();
  };

  // Auto-fit ONLY when a genuinely new figure is loaded — i.e. the set of clusters
  // changes (upload, example, session open). Every other scene rebuild — a style
  // tweak, colour change, reverse, align, rename, or drag — keeps the current
  // zoom/pan and just redraws, so tuning the figure never yanks the view back to
  // fit. Recenter on demand with the fit button or the 0 key.
  //
  // Keyed on the sorted cluster uids: new uploads mint fresh uuids, while in-place
  // edits keep theirs, which is exactly the distinction we want.
  const figureKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = data ? data.clusters.map((c) => c.uid).sort().join("|") : null;
    const isNewFigure = key !== figureKeyRef.current;
    figureKeyRef.current = key;
    // A brand-new figure fits (deferred a frame); anything else redraws in place.
    // Clearing the data (New) has no scene to fit, so it must take the render()
    // path, which wipes the canvas — fit() would bail out and leave the old figure.
    if (isNewFigure && scene && !hDraggingRef.current) {
      const id = requestAnimationFrame(() => fit());
      return () => cancelAnimationFrame(id);
    }
    render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  // Redraw (no refit) when draw-only style changes, the CDS-label scope changes, or
  // the inspector spotlights a different link.
  useEffect(() => {
    render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, geneLabelEligible, highlight]);

  // Keep the canvas sized to its container.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => render());
    ro.observe(wrap);
    render();
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sorted list of lanes with their screen-Y baseline (vertical order == lane index).
  const laneCenters = (): { lane: number; y: number }[] => {
    const byLane = new Map<number, number>();
    for (const c of ctlsRef.current) if (!byLane.has(c.lane)) byLane.set(c.lane, c.centerY);
    return [...byLane.entries()].map(([lane, y]) => ({ lane, y })).sort((a, b) => a.lane - b.lane);
  };

  // Resolve where a drag would drop: onto an existing lane (group) or into a gap (new row).
  const resolveTarget = (px: number, py: number): { target: MoveTarget; drop: DropTarget } => {
    const z = zoom.current;
    const th = cfgRef.current.trackHeight * z;
    const step = (cfgRef.current.trackHeight + cfgRef.current.rowGap) * z;
    const joinR = th / 2 + 8;
    const centers = laneCenters();

    const joined = centers.find((l) => Math.abs(l.y - py) <= joinR);
    if (joined) {
      const inLane = ctlsRef.current
        .filter((c) => c.lane === joined.lane && c.uid !== dragUid.current)
        .sort((a, b) => a.centerX - b.centerX);
      let pos = 0;
      for (const c of inLane) {
        if (c.centerX < px) pos++;
        else break;
      }
      return {
        target: { type: "lane", lane: joined.lane, pos },
        drop: { kind: "join", y: joined.y, height: th + 12, x: px },
      };
    }

    let at = 0;
    for (const l of centers) {
      if (l.y < py) at++;
      else break;
    }
    let gapY: number;
    if (centers.length === 0) gapY = py;
    else if (at === 0) gapY = centers[0].y - step / 2;
    else if (at >= centers.length) gapY = centers[centers.length - 1].y + step / 2;
    else gapY = (centers[at - 1].y + centers[at].y) / 2;
    return { target: { type: "new", at }, drop: { kind: "new", y: gapY, height: 0 } };
  };

  // Open the inline editor over a cluster's label, in screen space. Works whether
  // the label is visible or hidden (positions from the same world coords draw uses).
  const openLabelEditor = (id: string) => {
    const s = sceneRef.current;
    const lab = s?.labels.find((l) => l.id === id);
    if (!lab) return;
    const cfg = cfgRef.current;
    const fs = cfg.clusterFontSize;
    const view = { zoom: zoom.current, panX: pan.current.x, panY: pan.current.y, cssW: wrapRef.current?.clientWidth ?? 0 };
    const r = labelScreenRect(lab, cfg, view);
    const w = measureLabel(lab.name, fs);
    setEditing({ id, kind: lab.kind, value: lab.name, left: r.left, top: r.top, width: Math.max(w + 28, 130), fontSize: fs });
  };

  // Commit the rename. Reads the latest value from the ref and nulls it first, so
  // the Enter-then-blur pair doesn't apply twice; the store write runs here in the
  // event-handler context (never inside a setState updater / during render).
  // Empty/whitespace keeps the old name.
  const commitLabelEdit = () => {
    const cur = editingRef.current;
    if (!cur) return;
    editingRef.current = null;
    setEditing(null);
    const name = cur.value.trim();
    if (name) {
      // A merged row gets its own name, stored against the row rather than any one
      // cluster — so the members' original names survive and return on a split.
      if (cur.kind === "row") useStore.getState().setRowName(cur.id, name);
      else useStore.getState().renameCluster(cur.id, name);
    }
  };

  // Zoom about the canvas center, hover hit-testing, and drag-driven grouping/reordering.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Map convention (Figma / Google Maps): scrolling pans, ⌘/Ctrl + scroll zooms
    // toward the cursor. Browsers synthesise a ctrlKey wheel event for a trackpad
    // pinch, so pinch-to-zoom works without a separate gesture handler.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
      } else {
        panBy(-e.deltaX, -e.deltaY);
      }
    };

    // Gene under a world point (axis-aligned rectangle test).
    const geneAt = (wx: number, wy: number): string | null => {
      const s = sceneRef.current;
      if (!s) return null;
      const th = cfgRef.current.trackHeight / 2;
      const hit = s.genes.find(
        (g) => wx >= Math.min(g.x0, g.x1) && wx <= Math.max(g.x0, g.x1) && wy >= g.y - th && wy <= g.y + th
      );
      return hit ? hit.uid : null;
    };

    // Press on the canvas begins a view pan. Cluster drags start from their own
    // handle (an HTML button above the canvas), so reaching here means the press
    // was on the figure itself — which pans, exactly like dragging a map.
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || dragUid.current != null) return;
      panDrag.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        panX: pan.current.x,
        panY: pan.current.y,
        moved: false,
      };
      canvas.style.cursor = "grabbing";
    };

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      if (panDrag.current.active) {
        const dx = e.clientX - panDrag.current.startX;
        const dy = e.clientY - panDrag.current.startY;
        if (!panDrag.current.moved && Math.hypot(dx, dy) > PAN_SLOP) panDrag.current.moved = true;
        if (panDrag.current.moved) {
          pan.current = { x: panDrag.current.panX + dx, y: panDrag.current.panY + dy };
          // A moving view invalidates any tooltip anchored to the old position.
          setHover(null);
          setHoverLink(null);
          render();
        }
        return;
      }

      // Moving a cluster from its handle: horizontal movement slides it within its
      // row; dragging over another row (or a gap) switches to a re-home, previewed
      // with a drop indicator. One gesture, both axes.
      if (dragUid.current != null) {
        const uid = dragUid.current;
        const curCtl = ctlsRef.current.find((c) => c.uid === uid);
        // Stay in "slide" mode while the cursor is within the current row's vertical
        // territory (halfway to the neighbouring row the cursor heads for, or half a
        // row-stride at the edges; rows can sit further apart with extra space above).
        // This comfortably covers the handle, which sits at the label above the track.
        // Moving further toward another row switches to a re-home preview.
        let inOwnRow = false;
        if (curCtl != null) {
          const centers = laneCenters();
          const neighbour = centers[centers.findIndex((l) => l.lane === curCtl.lane) + (my < curCtl.centerY ? -1 : 1)];
          const reach = neighbour
            ? Math.abs(neighbour.y - curCtl.centerY) / 2
            : ((cfgRef.current.trackHeight + cfgRef.current.rowGap) * zoom.current) / 2;
          inOwnRow = Math.abs(my - curCtl.centerY) <= reach;
        }
        if (inOwnRow) {
          // Slide live; sliding past a neighbour reorders it within the row on release.
          pendingTarget.current = null;
          setDropTarget(null);
          const dxWorld = (mx - hDragStartX.current) / zoom.current;
          useStore.getState().setClusterOffset(uid, hDragStartOffset.current + dxWorld);
        } else {
          // Over another row / a gap → preview the move; any slide is discarded on drop.
          const { target, drop } = resolveTarget(mx, my);
          pendingTarget.current = target;
          setDropTarget(drop);
        }
        return;
      }

      const s = sceneRef.current;
      if (!s) return;
      const wx = (mx - pan.current.x) / zoom.current;
      const wy = (my - pan.current.y) / zoom.current;
      const hitUid = geneAt(wx, wy);
      if (hitUid) {
        const gene = geneById.get(hitUid);
        if (gene) {
          setHover({ gene, sx: mx, sy: my });
          setHoverLink(null);
          canvas.style.cursor = "pointer";
          return;
        }
      }
      // No gene under the cursor — fall back to ribbons (drawn beneath the genes).
      if (cfgRef.current.showLinks && hitCtxRef.current) {
        const hitCtx = hitCtxRef.current;
        const lps = linkPathsRef.current;
        // Iterate topmost-first (later ribbons draw over earlier ones).
        for (let i = lps.length - 1; i >= 0; i--) {
          if (hitCtx.isPointInPath(lps[i].path, wx, wy)) {
            setHoverLink({ link: lps[i].link, sx: mx, sy: my });
            setHover(null);
            canvas.style.cursor = "pointer";
            return;
          }
        }
      }
      setHover(null);
      setHoverLink(null);
      // Bare canvas is draggable, so advertise it.
      canvas.style.cursor = "grab";
    };

    const onUp = () => {
      if (panDrag.current.active) {
        panDrag.current.active = false;
        canvas.style.cursor = "grab";
        // `moved` survives until the click event that follows this mouseup has
        // been handled, so a pan can't double as a click. onClick clears it.
      }
      if (dragUid.current != null) {
        const uid = dragUid.current;
        const target = pendingTarget.current;
        dragUid.current = null;
        pendingTarget.current = null;
        hDraggingRef.current = false;
        setDraggingUid(null);
        setDropTarget(null);
        setHDraggingUid(null);
        canvas.style.cursor = "default";
        if (target) {
          // Re-homed to another row / new row (drops any within-row offset).
          useStore.getState().moveClusterTo(uid, target);
        } else {
          // Stayed in its row → persist the slid position (and any reorder by X).
          if (cfgRef.current.preventOverlap) commitSlide(uid);
        }
      }
    };
    const onLeave = () => {
      setHover(null);
      setHoverLink(null);
    };

    // Left-click never *opens* the inspector — that's right-click (see
    // onContextMenu), so a double-click meant to align matching genes doesn't flash the
    // panel open on its leading click. Bare-canvas click still dismisses an open
    // inspector (click-away to close). In "custom" colour mode with an active
    // group, click stays the gene-assignment gesture the tooltip advertises.
    const onClick = (e: MouseEvent) => {
      // The click that ends a pan gesture is not a selection.
      if (panDrag.current.moved) {
        panDrag.current.moved = false;
        return;
      }
      const st = useStore.getState();
      const s = sceneRef.current;
      if (!s) return;
      const rect = canvas.getBoundingClientRect();
      const wx = (e.clientX - rect.left - pan.current.x) / zoom.current;
      const wy = (e.clientY - rect.top - pan.current.y) / zoom.current;
      const uid = geneAt(wx, wy);
      if (st.colourBy === "custom" && st.activeCustomGroup) {
        if (uid) st.toggleGeneInCustomGroup(uid);
        return;
      }
      // Only a click on empty canvas closes an open inspector; a click on a gene
      // leaves it as-is.
      if (!uid) st.selectGene(null);
    };

    // Right-click always inspects, in every colour mode — the one gesture that
    // never competes with custom-group assignment. Suppresses the browser menu
    // only when it actually hits a gene, so the page menu still works elsewhere.
    const onContextMenu = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const wx = (e.clientX - rect.left - pan.current.x) / zoom.current;
      const wy = (e.clientY - rect.top - pan.current.y) / zoom.current;
      const uid = geneAt(wx, wy);
      if (!uid) return;
      e.preventDefault();
      useStore.getState().selectGene(uid);
    };

    // Double-clicking a gene aligns every cluster's match for that gene to the
    // clicked gene's world X. Hit-test uses the same world-coord transform as hover.
    const onDblClick = (e: MouseEvent) => {
      const s = sceneRef.current;
      if (!s) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Double-click a cluster label (track name) to rename it in place.
      if (cfgRef.current.showClusterNames) {
        const cfg = cfgRef.current;
        const view = { zoom: zoom.current, panX: pan.current.x, panY: pan.current.y, cssW: wrapRef.current?.clientWidth ?? 0 };
        const labHit = s.labels.find((lab) => {
          const r = labelScreenRect(lab, cfg, view);
          return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom;
        });
        if (labHit) {
          openLabelEditor(labHit.id);
          return;
        }
      }

      // Otherwise, double-clicking a gene aligns every cluster's match for it.
      const wx = (mx - pan.current.x) / zoom.current;
      const wy = (my - pan.current.y) / zoom.current;
      const uid = geneAt(wx, wy);
      if (uid) useStore.getState().centerClustersOnGene(uid);
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mousedown", onDown);
    // Move/up live on the window so a drag that leaves the canvas keeps tracking.
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("contextmenu", onContextMenu);
    canvas.addEventListener("dblclick", onDblClick);
    canvas.style.cursor = "grab";
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("dblclick", onDblClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geneById]);

  const zoomBy = (factor: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    zoomAt(factor, wrap.clientWidth / 2, wrap.clientHeight / 2);
  };

  // Keyboard navigation: arrows pan, +/− zoom, 0 refits, Escape closes the
  // inspector. Arrows follow scroll convention (↓ moves the view down, so the
  // figure travels up), matching the two-finger scroll pan.
  useEffect(() => {
    const PAN_STEP = 60;
    const onKey = (e: KeyboardEvent) => {
      // Leave modifier chords to their owners (⌘Z undo lives in TopBar), and
      // never steal keys from the inline rename editor or panel inputs.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const step = PAN_STEP * (e.shiftKey ? 4 : 1);
      switch (e.key) {
        case "ArrowLeft": panBy(step, 0); break;
        case "ArrowRight": panBy(-step, 0); break;
        case "ArrowUp": panBy(0, step); break;
        case "ArrowDown": panBy(0, -step); break;
        case "+": case "=": zoomBy(1.2); break;
        case "-": case "_": zoomBy(1 / 1.2); break;
        case "0": fit(); break;
        case "Escape": useStore.getState().selectGene(null); break;
        default: return;
      }
      e.preventDefault(); // arrows and +/− would otherwise scroll or zoom the page
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startDrag = (uid: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    // Checkpoint before the drag so the whole gesture is one undo step.
    useStore.getState().beginHistoryStep();
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    dragUid.current = uid;
    pendingTarget.current = null;
    // Remember where the drag began so horizontal movement maps to an X offset.
    hDragStartX.current = rect ? e.clientX - rect.left : e.clientX;
    hDragStartOffset.current = useStore.getState().clusterOffsets[uid] ?? 0;
    // Anchor overlap resolution to this cluster and suppress refit while dragging.
    hDraggingRef.current = true;
    setDraggingUid(uid);
    setHDraggingUid(uid);
    if (canvas) canvas.style.cursor = "grabbing";
  };

  // On release of a horizontal slide, persist the resolved layout: reorder the
  // lane to the on-screen left-to-right order and rewrite offsets so the new
  // sequential base + offset reproduces the exact current positions. This keeps
  // future overlap resolution continuous (a cluster dragged past a neighbour
  // stays put instead of snapping back). Only needed when overlap is prevented;
  // otherwise offsets already equal the on-screen positions.
  const commitSlide = (uid: string) => {
    const s = sceneRef.current;
    if (!s) return;
    const box = s.clusters.find((b) => b.uid === uid);
    if (!box) return;
    const laneIdx = box.lane;
    // Order by where each *cluster* sits. Never by its name: names can be pinned to a
    // shared column, or merged away entirely when a row holds several clusters.
    const laneBoxes = s.clusters.filter((b) => b.lane === laneIdx).sort((a, b) => a.x0 - b.x0);
    const colGap = cfgRef.current.colGap;
    const order: string[] = [];
    const offsets: Record<string, number> = {};
    let base = 0;
    for (const b of laneBoxes) {
      order.push(b.uid);
      offsets[b.uid] = b.x0 - base; // reproduce current left edge from the new base
      base += b.w + colGap;
    }
    useStore.getState().setLaneArrangement(laneIdx, order, offsets);
  };

  return (
    <div className="canvas-view" ref={wrapRef}>
      <canvas ref={canvasRef} />

      {!data && <CanvasWelcome />}

      {dropTarget && (
        dropTarget.kind === "join" ? (
          <>
            <div
              className="drop-band"
              style={{ top: dropTarget.y - dropTarget.height / 2, height: dropTarget.height }}
            />
            {dropTarget.x != null && (
              <div
                className="drop-caret"
                style={{ left: dropTarget.x, top: dropTarget.y - dropTarget.height / 2, height: dropTarget.height }}
              />
            )}
          </>
        ) : (
          <div className="drop-line" style={{ top: dropTarget.y }} />
        )
      )}

      {data && (
        <div className="row-controls">
          {ctls.map((c) => (
            <div
              key={c.uid}
              className={
                "cluster-control" +
                (c.atLeft ? " anchor-right" : "") +
                (draggingUid === c.uid ? " dragging" : "")
              }
              style={{ left: c.left, top: c.renderY }}
            >
              <button
                className="row-handle"
                title="Drag to move — sideways to slide within its row, up/down to move to another row"
                onMouseDown={startDrag(c.uid)}
              >
                ⠿
              </button>
              <button
                className={"row-reverse" + (c.reversed ? " active" : "")}
                title={c.reversed ? "Restore original direction" : "Reverse sequence direction"}
                onClick={() => useStore.getState().toggleClusterReversed(c.uid)}
              >
                ⇄
              </button>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <input
          className="label-edit"
          style={{ left: editing.left, top: editing.top, width: editing.width, fontSize: editing.fontSize }}
          value={editing.value}
          autoFocus
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setEditing((cur) => (cur ? { ...cur, value: e.target.value } : cur))}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commitLabelEdit(); }
            else if (e.key === "Escape") { e.preventDefault(); editingRef.current = null; setEditing(null); }
          }}
          onBlur={commitLabelEdit}
        />
      )}

      {hover && (
        <FloatingTip sx={hover.sx} sy={hover.sy}>
          <div className="tt-title">{hover.gene.label}</div>
          <div className="tt-row">
            {hover.gene.start.toLocaleString()}–{hover.gene.end.toLocaleString()} bp ({hover.gene.strand < 0 ? "−" : "+"})
          </div>
          {qualifierEntries(hover.gene).map(([k, v]) => (
            <div className="tt-row" key={k}>
              <span className="tt-key">{k}</span> {v}
            </div>
          ))}
          <div className="tt-row tt-hint">Right-click for full details</div>
          {colourBy === "custom" && (
            <div className="tt-row tt-hint">
              {activeGroupLabel
                ? customGroups.find((g) => g.id === activeCustomGroup)?.genes.includes(hover.gene.uid)
                  ? `Click to remove from “${activeGroupLabel}”`
                  : `Click to add to “${activeGroupLabel}”`
                : "Select a custom group to assign genes"}
            </div>
          )}
        </FloatingTip>
      )}
      {hoverLink && (() => {
        const l = hoverLink.link;
        const q = geneById.get(l.query);
        const t = geneById.get(l.target);
        // Present metrics, active metric first.
        const rows = (Object.keys(l.metrics) as MetricKey[])
          .filter((k) => l.metrics[k] != null)
          .sort((a, b) => (a === activeMetric ? -1 : b === activeMetric ? 1 : 0));
        const partial = l.query_start != null && l.query_end != null;
        return (
          <FloatingTip sx={hoverLink.sx} sy={hoverLink.sy}>
            <div className="tt-title">
              {(q?.label ?? l.query)} ↔ {(t?.label ?? l.target)}
            </div>
            {rows.map((k) => (
              <div className="tt-row" key={k}>
                <span className="tt-key">{METRIC_LABELS[k] ?? k}</span> {formatMetric(l.metrics[k], k)}
              </div>
            ))}
            {partial && (
              <div className="tt-row tt-hint">
                aligned {Math.round((l.query_start as number) * 100)}–{Math.round((l.query_end as number) * 100)}% of query
              </div>
            )}
          </FloatingTip>
        );
      })()}
      {data && <GeneInspector />}

      {data && (
        <div className="canvas-controls">
          {/* Opens on hover (and on keyboard focus), so the controls are one
              pointer-rest away rather than needing a click to discover. */}
          <div className="canvas-help">
            <button className="icon-btn" aria-label="Controls and shortcuts">ⓘ</button>
            <div className="canvas-help-menu" role="tooltip">
              <p>Moving around</p>
              <dl>
                <dt>Drag</dt><dd>Move the figure</dd>
                <dt>Scroll</dt><dd>Move up / down / sideways</dd>
                <dt>⌘ + scroll</dt><dd>Zoom at the pointer</dd>
                <dt>Arrows</dt><dd>Move — hold ⇧ for bigger steps</dd>
                <dt>+ / −</dt><dd>Zoom in / out</dd>
                <dt>0</dt><dd>Fit the whole figure</dd>
              </dl>
              <p>Genes</p>
              <dl>
                <dt>Hover</dt><dd>Quick annotation summary</dd>
                <dt>Right-click</dt><dd>Full protein details</dd>
                <dt>Double-click</dt><dd>Align matching genes across rows</dd>
              </dl>
              <p>Sequences</p>
              <dl>
                <dt>Drag ⠿</dt><dd>Slide along its row, or move to another</dd>
                <dt>Double-click name</dt><dd>Rename it</dd>
                <dt>⌘Z</dt><dd>Undo</dd>
              </dl>
            </div>
          </div>
          <button className="icon-btn" title="Zoom out (−)" onClick={() => zoomBy(1 / 1.2)}>−</button>
          <button className="icon-btn" title="Fit to view (0)" onClick={fit}>⤢</button>
          <button className="icon-btn" title="Zoom in (+)" onClick={() => zoomBy(1.2)}>+</button>
        </div>
      )}
    </div>
  );
}
