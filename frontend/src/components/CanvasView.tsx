import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, type MoveTarget } from "../state/store";
import { computeColours } from "../render/palette";
import { buildScene, type Scene } from "../render/layout";
import { makeConfig } from "../render/style";
import { draw } from "../render/draw";
import CanvasWelcome from "./CanvasWelcome";
import type { Gene } from "../types";

interface ClusterCtl {
  uid: string;
  name: string;
  lane: number;
  reversed: boolean;
  left: number; // screen x where the control starts (just past the label text)
  centerY: number; // screen y of the track baseline (drag/drop truth)
  renderY: number; // screen y used to place the control (de-collided)
  centerX: number; // screen x of the cluster's horizontal centre
}

// Measure label text at its on-screen size so a control can sit right after it.
// Cluster names render at exactly `clusterFontSize` CSS px regardless of zoom
// (world font is scaled by zoom in draw()), so measuring at that size is exact.
let measureCtx: CanvasRenderingContext2D | null | undefined;
function labelTextWidth(name: string, fontSize: number): number {
  if (measureCtx === undefined) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return name.length * fontSize * 0.55; // fallback estimate
  measureCtx.font = `600 ${fontSize}px system-ui, sans-serif`;
  return measureCtx.measureText(name).width;
}

interface DropTarget {
  kind: "join" | "new";
  y: number;
  height: number;
  x?: number;
}

type LabelEdit = { uid: string; value: string; left: number; top: number; width: number; fontSize: number };

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

export default function CanvasView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const data = useStore((s) => s.data);
  const lanes = useStore((s) => s.lanes);
  const clusterOffsets = useStore((s) => s.clusterOffsets);
  const activeMetric = useStore((s) => s.activeMetric);
  const colourBy = useStore((s) => s.colourBy);
  const paletteName = useStore((s) => s.paletteName);
  const overrides = useStore((s) => s.overrides);
  const colourField = useStore((s) => s.colourField);
  const customGroups = useStore((s) => s.customGroups);
  const activeCustomGroup = useStore((s) => s.activeCustomGroup);
  const style = useStore((s) => s.style);

  const colours = useMemo(
    () =>
      data
        ? computeColours(data, colourBy, paletteName, overrides, colourField, customGroups, style.maxLegendEntries)
        : { gene: new Map<string, string>(), items: [] },
    [data, colourBy, paletteName, overrides, colourField, customGroups, style.maxLegendEntries]
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
          )
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      data, lanes, clusterOffsets, colours, activeMetric, hDraggingUid,
      style.pxPerKb, style.clusterSpacing, style.trackHeight,
      style.preventOverlap, style.showLinks, style.linkThreshold, style.linkOpacity,
      style.anchorLinksToAligned, style.minFragmentAa,
      style.colourLinks, style.showLinkLabels, style.showScaleBar, style.showLegend,
      style.scaleFontSize, style.legendFontSize,
      style.scaleBarKb, style.scaleBarThickness, style.legendSpacing,
    ]
  );

  const geneById = useMemo(() => {
    const m = new Map<string, Gene>();
    data?.clusters.forEach((c) => c.loci.forEach((l) => l.genes.forEach((g) => m.set(g.uid, g))));
    return m;
  }, [data]);

  const zoom = useRef(1);
  const pan = useRef({ x: 0, y: 0 });
  const sceneRef = useRef<Scene | null>(scene);
  sceneRef.current = scene;
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const [hover, setHover] = useState<{ gene: Gene; sx: number; sy: number } | null>(null);

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

  // Horizontal component of a cluster drag: maps cursor X to a within-row offset.
  const hDragStartX = useRef(0); // screen x where the drag began
  const hDragStartOffset = useRef(0); // cluster offset (world px) at drag start
  const hDraggingRef = useRef(false);
  // Skip the next auto-refit (used when committing a slide, so the view doesn't
  // recenter just because lanes/offsets changed while positions stayed put).
  const skipNextFit = useRef(false);

  const syncCtls = () => {
    const s = sceneRef.current;
    if (!s) {
      if (ctlsRef.current.length) setCtls([]);
      return;
    }
    const z = zoom.current;
    const px = pan.current.x;
    const py = pan.current.y;
    const th = cfgRef.current.trackHeight;
    const fs = cfgRef.current.clusterFontSize;
    const showNames = cfgRef.current.showClusterNames;
    const reversedByUid = new Map<string, boolean>();
    useStore.getState().data?.clusters.forEach((c) => reversedByUid.set(c.uid, !!c.reversed));
    const next: ClusterCtl[] = s.labels.map((lab) => {
      const labelStart = lab.x * z + px;
      const textW = showNames ? labelTextWidth(lab.name, fs) + 8 : 0;
      return {
        uid: lab.uid,
        name: lab.name,
        lane: lab.lane,
        reversed: !!reversedByUid.get(lab.uid),
        // Sit just to the right of the label text.
        left: labelStart + textW,
        // Track baseline: the drag/drop truth (join zones align to the arrow row).
        centerY: (lab.y + th) * z + py,
        // Vertically centre on the label. lab.y is its text baseline (drawn
        // textBaseline "alphabetic"), so nudge up to the optical middle.
        renderY: lab.y * z + py - fs * 0.32,
        centerX: (lab.x + lab.w / 2) * z + px,
      };
    });
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
    draw(ctx, sceneRef.current, { dpr, cssW, cssH, zoom: zoom.current, panX: pan.current.x, panY: pan.current.y }, cfgRef.current);
    syncCtls();
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
    const pad = 48;
    const z = Math.min((cssW - 2 * pad) / bw, (cssH - 2 * pad) / bh, 4);
    zoom.current = z > 0 && isFinite(z) ? z : 1;
    pan.current = {
      x: (cssW - bw * zoom.current) / 2 - s.bounds.minX * zoom.current,
      y: (cssH - bh * zoom.current) / 2 - s.bounds.minY * zoom.current,
    };
    render();
  };

  // Refit when the scene is rebuilt (data / lanes / layout-affecting change), deferred a frame.
  // While sliding a cluster horizontally we redraw in place instead, so the view
  // doesn't recenter on every offset change.
  useEffect(() => {
    if (hDraggingRef.current || skipNextFit.current) {
      skipNextFit.current = false;
      render();
      return;
    }
    const id = requestAnimationFrame(() => fit());
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  // Redraw (no refit) when draw-only style changes.
  useEffect(() => {
    render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg]);

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
  const openLabelEditor = (uid: string) => {
    const s = sceneRef.current;
    const lab = s?.labels.find((l) => l.uid === uid);
    if (!lab) return;
    const z = zoom.current;
    const fs = cfgRef.current.clusterFontSize;
    const left = lab.x * z + pan.current.x;
    const baseline = lab.y * z + pan.current.y;
    const w = labelTextWidth(lab.name, fs);
    setEditing({ uid, value: lab.name, left, top: baseline - fs, width: Math.max(w + 28, 130), fontSize: fs });
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
      skipNextFit.current = true; // keep the current zoom/pan; renaming isn't a layout change
      useStore.getState().renameCluster(cur.uid, name);
    }
  };

  // Zoom about the canvas center, hover hit-testing, and drag-driven grouping/reordering.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const zoomAtCenter = (factor: number) => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const cx = wrap.clientWidth / 2;
      const cy = wrap.clientHeight / 2;
      const wx = (cx - pan.current.x) / zoom.current;
      const wy = (cy - pan.current.y) / zoom.current;
      zoom.current = Math.min(8, Math.max(0.05, zoom.current * factor));
      pan.current = { x: cx - wx * zoom.current, y: cy - wy * zoom.current };
      render();
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAtCenter(Math.exp(-e.deltaY * 0.0015));
    };

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Moving a cluster from its handle: horizontal movement slides it within its
      // row; dragging over another row (or a gap) switches to a re-home, previewed
      // with a drop indicator. One gesture, both axes.
      if (dragUid.current != null) {
        const uid = dragUid.current;
        const curCtl = ctlsRef.current.find((c) => c.uid === uid);
        // Stay in "slide" mode while the cursor is within the current row's vertical
        // territory (half a row-stride around its baseline). This comfortably covers
        // the handle, which sits at the label above the track. Moving further toward
        // another row switches to a re-home preview.
        const stride = (cfgRef.current.trackHeight + cfgRef.current.rowGap) * zoom.current;
        const inOwnRow = curCtl != null && Math.abs(my - curCtl.centerY) <= stride / 2;
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
      const th = cfgRef.current.trackHeight / 2;
      const hit = s.genes.find(
        (g) => wx >= Math.min(g.x0, g.x1) && wx <= Math.max(g.x0, g.x1) && wy >= g.y - th && wy <= g.y + th
      );
      if (hit) {
        const gene = geneById.get(hit.uid);
        if (gene) {
          setHover({ gene, sx: mx, sy: my });
          canvas.style.cursor = "pointer";
          return;
        }
      }
      setHover(null);
      canvas.style.cursor = "default";
    };

    const onUp = () => {
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
          // Stayed in its row → persist the slid position (and any reorder by X),
          // keeping the current view instead of refitting.
          if (cfgRef.current.preventOverlap) commitSlide(uid);
          skipNextFit.current = true;
        }
      }
    };
    const onLeave = () => setHover(null);

    // In "custom" colour mode, a single click on a gene toggles its membership
    // in the active custom group (no-op in other modes / with no active group).
    const onClick = (e: MouseEvent) => {
      const st = useStore.getState();
      if (st.colourBy !== "custom" || !st.activeCustomGroup) return;
      const s = sceneRef.current;
      if (!s) return;
      const rect = canvas.getBoundingClientRect();
      const wx = (e.clientX - rect.left - pan.current.x) / zoom.current;
      const wy = (e.clientY - rect.top - pan.current.y) / zoom.current;
      const th = cfgRef.current.trackHeight / 2;
      const hit = s.genes.find(
        (g) => wx >= Math.min(g.x0, g.x1) && wx <= Math.max(g.x0, g.x1) && wy >= g.y - th && wy <= g.y + th
      );
      if (hit) st.toggleGeneInCustomGroup(hit.uid);
    };

    // Double-clicking a gene aligns every cluster's homolog of that gene to the
    // clicked gene's world X. Hit-test uses the same world-coord transform as hover.
    const onDblClick = (e: MouseEvent) => {
      const s = sceneRef.current;
      if (!s) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Double-click a cluster label (track name) to rename it in place.
      if (cfgRef.current.showClusterNames) {
        const z = zoom.current;
        const fs = cfgRef.current.clusterFontSize;
        const labHit = s.labels.find((lab) => {
          const x0 = lab.x * z + pan.current.x;
          const baseline = lab.y * z + pan.current.y;
          const w = labelTextWidth(lab.name, fs);
          return mx >= x0 && mx <= x0 + w && my >= baseline - fs && my <= baseline + fs * 0.35;
        });
        if (labHit) {
          openLabelEditor(labHit.uid);
          return;
        }
      }

      // Otherwise, double-clicking a gene aligns every cluster's homolog of it.
      const wx = (mx - pan.current.x) / zoom.current;
      const wy = (my - pan.current.y) / zoom.current;
      const th = cfgRef.current.trackHeight / 2;
      const hit = s.genes.find(
        (g) => wx >= Math.min(g.x0, g.x1) && wx <= Math.max(g.x0, g.x1) && wy >= g.y - th && wy <= g.y + th
      );
      if (hit) useStore.getState().centerClustersOnGene(hit.uid);
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("dblclick", onDblClick);
    canvas.style.cursor = "default";
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("dblclick", onDblClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geneById]);

  const zoomBy = (factor: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const cx = wrap.clientWidth / 2;
    const cy = wrap.clientHeight / 2;
    const wx = (cx - pan.current.x) / zoom.current;
    const wy = (cy - pan.current.y) / zoom.current;
    zoom.current = Math.min(8, Math.max(0.05, zoom.current * factor));
    pan.current = { x: cx - wx * zoom.current, y: cy - wy * zoom.current };
    render();
  };

  const startDrag = (uid: string) => (e: React.MouseEvent) => {
    e.preventDefault();
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
    const lab = s.labels.find((l) => l.uid === uid);
    if (!lab) return;
    const laneIdx = lab.lane;
    const laneLabels = s.labels.filter((l) => l.lane === laneIdx).sort((a, b) => a.x - b.x);
    const colGap = cfgRef.current.colGap;
    const order: string[] = [];
    const offsets: Record<string, number> = {};
    let base = 0;
    for (const l of laneLabels) {
      order.push(l.uid);
      offsets[l.uid] = l.x - base; // reproduce current left edge from the new base
      base += l.w + colGap;
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
              className={"cluster-control" + (draggingUid === c.uid ? " dragging" : "")}
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
                title={c.reversed ? "Restore original direction" : "Reverse cluster direction"}
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
        <div className="gene-tooltip" style={{ left: hover.sx + 14, top: hover.sy + 14 }}>
          <div className="tt-title">{hover.gene.label}</div>
          <div className="tt-row">
            {hover.gene.start.toLocaleString()}–{hover.gene.end.toLocaleString()} bp ({hover.gene.strand < 0 ? "−" : "+"})
          </div>
          {Object.entries(hover.gene.names)
            .slice(0, 4)
            .map(([k, v]) => (
              <div className="tt-row" key={k}>
                <span className="tt-key">{k}</span> {v}
              </div>
            ))}
          {colourBy === "custom" && (
            <div className="tt-row tt-hint">
              {activeGroupLabel
                ? customGroups.find((g) => g.id === activeCustomGroup)?.genes.includes(hover.gene.uid)
                  ? `Click to remove from “${activeGroupLabel}”`
                  : `Click to add to “${activeGroupLabel}”`
                : "Select a custom group to assign genes"}
            </div>
          )}
        </div>
      )}
      {data && (
        <div className="canvas-controls">
          <button className="icon-btn" title="Zoom out" onClick={() => zoomBy(1 / 1.2)}>−</button>
          <button className="icon-btn" title="Fit to view" onClick={fit}>⤢</button>
          <button className="icon-btn" title="Zoom in" onClick={() => zoomBy(1.2)}>+</button>
        </div>
      )}
    </div>
  );
}
