import { create } from "zustand";
import type { FigureData, MetricKey } from "../types";
import { DEFAULT_PALETTE, PALETTES, computeColours, type ColourBy, type CustomGroup } from "../render/palette";
import { DEFAULT_STYLE, makeConfig, type StyleConfig } from "../render/style";
import { availableMetrics, buildScene, computeCenteringOffsets, effectiveLanes, restoreHiddenInLane, visibleLaneIndices } from "../render/layout";

/** A drop target for moving a cluster: into an existing lane, or a brand-new lane. */
export type MoveTarget =
  | { type: "lane"; lane: number; pos: number }
  | { type: "new"; at: number };

export interface SessionView {
  lanes: string[][];
  /** Per-cluster horizontal shift (world px) applied on top of sequential lane packing. */
  clusterOffsets: Record<string, number>;
  /** Clusters treated as circular sequences (origin can be rotated). Keyed by uid. */
  circularClusters: Record<string, boolean>;
  /** Per-cluster origin rotation for circular clusters, in whole-CDS steps. Positive
   * moves the origin forward, so the first CDS wraps to the end. */
  clusterRotation: Record<string, number>;
  /** Clusters left off the figure, keyed by uid. They keep their place in `lanes`
   * so showing one again returns it to its row. */
  hiddenClusters: Record<string, boolean>;
  activeMetric: MetricKey;
  colourBy: ColourBy;
  paletteName: string;
  overrides: Record<string, string>;
  /** GenBank/GFF qualifier key used when colourBy === "field" (e.g. "product"). */
  colourField: string;
  /** Hand-built colour groups used when colourBy === "custom". */
  customGroups: CustomGroup[];
  /** Which custom group receives genes clicked on the figure (null = none). */
  activeCustomGroup: string | null;
  /** Names given to merged (pinned, multi-cluster) rows, keyed by `rowKey` of their
   * members. Per-cluster names are never touched, so splitting a row restores them. */
  rowNames: Record<string, string>;
  style: StyleConfig;
  /** Alignment engine used for the next similarity job ("diamond" | "parasail"). */
  engine: string;
  /** parasail alignment mode for the next job ("global" | "local"). */
  mode: string;
  /** Minimum identity (0–1) to keep a link when the next job runs. */
  identityCutoff: number;
  /** Maximum E-value to keep a hit when the next job runs (DIAMOND only). */
  evalueCutoff: number;
}

export interface Session {
  schemaVersion: number;
  data: FigureData | null;
  view: SessionView;
}

const SESSION_STORAGE_KEY = "weft.session.v1";

function defaultSessionView(): SessionView {
  return {
    lanes: [],
    clusterOffsets: {},
    circularClusters: {},
    clusterRotation: {},
    hiddenClusters: {},
    activeMetric: "identity",
    colourBy: "group",
    paletteName: DEFAULT_PALETTE,
    overrides: {},
    colourField: "",
    customGroups: [],
    activeCustomGroup: null,
    rowNames: {},
    style: { ...DEFAULT_STYLE },
    // parasail global is the default: exact, always available, and matches the
    // backend's JobRequest default. fetchCapabilities may still swap this for the
    // server's advertised default if the stored engine isn't runnable.
    engine: "parasail",
    mode: "global",
    identityCutoff: 0.3,
    evalueCutoff: 1e-3,
  };
}

/** Keep the active metric valid for the loaded data: if the alignment that
 * produced it doesn't populate the chosen metric, fall back to the first one it
 * does (e.g. switching DIAMOND→parasail drops bitscore/E-value). */
function clampMetric(metric: MetricKey, data: FigureData | null): MetricKey {
  const avail = availableMetrics(data);
  return avail.includes(metric) ? metric : (avail[0] ?? "identity");
}

/** Pick a distinct default colour for the nth custom group from the active palette. */
function defaultCustomColour(paletteName: string, index: number): string {
  const palette = PALETTES[paletteName] ?? PALETTES[DEFAULT_PALETTE];
  return palette[index % palette.length];
}

function newGroupId(): string {
  const rand = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `custom-${rand}`;
}

function loadPersistedSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.view) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** One row per cluster, except that records split from one file (a draft
 * assembly's contigs) start together in a single row. */
function initialLanes(data: FigureData | null): string[][] {
  if (!data) return [];
  const lanes: string[][] = [];
  const laneByFile = new Map<string, string[]>();
  for (const c of data.clusters) {
    const file = c.metadata?.source_file;
    const lane = file ? laneByFile.get(file) : undefined;
    if (lane) {
      lane.push(c.uid);
      continue;
    }
    const fresh = [c.uid];
    lanes.push(fresh);
    if (file) laneByFile.set(file, fresh);
  }
  return lanes;
}

/** A complete, serialisable snapshot of the current session (data + view). All
 * mutations are immutable, so the referenced arrays/objects are safe to keep as
 * history entries — they are never mutated in place. Shared by getSession (save,
 * persistence) and the undo/redo history stack. */
function snapshotOf(s: AppState): Session {
  return {
    schemaVersion: 1,
    data: s.data,
    view: {
      lanes: s.lanes,
      clusterOffsets: s.clusterOffsets,
      circularClusters: s.circularClusters,
      clusterRotation: s.clusterRotation,
      hiddenClusters: s.hiddenClusters,
      activeMetric: s.activeMetric,
      colourBy: s.colourBy,
      paletteName: s.paletteName,
      overrides: s.overrides,
      colourField: s.colourField,
      customGroups: s.customGroups,
      activeCustomGroup: s.activeCustomGroup,
      rowNames: s.rowNames,
      style: s.style,
      engine: s.engine,
      mode: s.mode,
      identityCutoff: s.identityCutoff,
      evalueCutoff: s.evalueCutoff,
    },
  };
}

/** Field-restoration patch applied when a session snapshot becomes the live state
 * — the single code path shared by loadSession (file open) and undo/redo. */
function sessionToState(session: Session) {
  return {
    data: session.data,
    lanes: session.view.lanes ?? initialLanes(session.data),
    clusterOffsets: session.view.clusterOffsets ?? {},
    circularClusters: session.view.circularClusters ?? {},
    clusterRotation: session.view.clusterRotation ?? {},
    hiddenClusters: session.view.hiddenClusters ?? {},
    activeMetric: clampMetric(session.view.activeMetric, session.data),
    colourBy: session.view.colourBy,
    paletteName: session.view.paletteName,
    overrides: session.view.overrides ?? {},
    colourField: session.view.colourField ?? "",
    customGroups: session.view.customGroups ?? [],
    activeCustomGroup: session.view.activeCustomGroup ?? null,
    rowNames: session.view.rowNames ?? {},
    style: { ...DEFAULT_STYLE, ...(session.view.style ?? {}) },
    engine: session.view.engine ?? "parasail",
    mode: session.view.mode ?? "global",
    identityCutoff: session.view.identityCutoff ?? 0.3,
    evalueCutoff: session.view.evalueCutoff ?? 1e-3,
    jobStatus: "idle",
    jobError: null,
    staged: [],
    separateRecords: {},
  };
}

/** The inspector's gene, unless `session` hides the cluster it belongs to (undo or
 * redo can re-hide a cluster while one of its genes is open). */
function selectionAfter(selectedGene: string | null, session: Session): string | null {
  if (!selectedGene || !session.data) return selectedGene;
  const hidden = session.view.hiddenClusters ?? {};
  const owner = session.data.clusters.find((c) => c.loci.some((l) => l.genes.some((g) => g.uid === selectedGene)));
  return owner && hidden[owner.uid] ? null : selectedGene;
}

interface AppState extends SessionView {
  data: FigureData | null;
  panelCollapsed: boolean;
  jobStatus: string;
  // Why the last job failed, in words fit for the user; null unless jobStatus is "failed".
  jobError: string | null;
  // Gene open in the inspector. Deliberately outside SessionView: selecting a
  // protein is navigation, not a figure edit, so it stays out of undo history,
  // the saved session and the autosave.
  selectedGene: string | null;
  // Similarity link whose row is hovered in the inspector, spotlit on the canvas.
  // Transient, like selectedGene.
  highlightedLink: string | null;
  // Files chosen but not yet aligned. Transient (never persisted); the upload
  // hook stages into it and the explicit "Run" button consumes it. Shared so the
  // left panel and the welcome screen see one staging queue.
  staged: File[];
  // Staged file names whose records are sent as separate sequences. Transient
  // like `staged`, which it is cleared with.
  separateRecords: Record<string, boolean>;

  setData: (d: FigureData | null) => void;
  setStaged: (files: File[]) => void;
  setSeparateRecords: (name: string, on: boolean) => void;
  moveClusterTo: (uid: string, target: MoveTarget) => void;
  setClusterOffset: (uid: string, offset: number) => void;
  /** Mark/unmark a cluster as a circular sequence (enables origin rotation). */
  toggleClusterCircular: (uid: string) => void;
  /** Mark every loaded cluster circular or linear in one undoable action. */
  setAllClustersCircular: (on: boolean) => void;
  /** Rotate a circular cluster's origin by `delta` whole-CDS steps (+forward). */
  rotateCluster: (uid: string, delta: number) => void;
  /** Restore every circular cluster to its original origin. */
  resetAllClusterRotations: () => void;
  /** Hide/show a cluster on the figure. The last visible cluster can't be hidden. */
  toggleClusterHidden: (uid: string) => void;
  /** Show every hidden cluster again. */
  showAllClusters: () => void;
  setLaneArrangement: (laneIndex: number, order: string[], offsets: Record<string, number>) => void;
  centerClustersOnGene: (geneUid: string) => void;
  clearClusterOffsets: () => void;
  toggleClusterReversed: (uid: string) => void;
  renameCluster: (uid: string, name: string) => void;
  /** Rename a similarity group (one of data.groups). */
  renameGroup: (uid: string, label: string) => void;
  /** Name a merged row (see SessionView.rowNames). Empty clears the override. */
  setRowName: (key: string, name: string) => void;
  setActiveMetric: (m: MetricKey) => void;
  setEngine: (engine: string) => void;
  setMode: (mode: string) => void;
  setIdentityCutoff: (v: number) => void;
  setEvalueCutoff: (v: number) => void;
  togglePanel: () => void;
  /** Set the job status; `error` explains a failure and is cleared by any other status. */
  setJobStatus: (s: string, error?: string | null) => void;
  /** Open the inspector on a gene (null closes it). */
  selectGene: (uid: string | null) => void;
  /** Spotlight a similarity link (and both its genes) on the canvas; null clears. */
  setHighlightedLink: (uid: string | null) => void;

  setColourBy: (c: ColourBy) => void;
  setPaletteName: (p: string) => void;
  setOverride: (id: string, colour: string) => void;
  setOverrides: (o: Record<string, string>) => void;
  clearOverrides: () => void;

  setColourField: (field: string) => void;
  addCustomGroup: () => void;
  renameCustomGroup: (id: string, label: string) => void;
  setCustomGroupColour: (id: string, colour: string) => void;
  removeCustomGroup: (id: string) => void;
  setActiveCustomGroup: (id: string | null) => void;
  toggleGeneInCustomGroup: (geneUid: string) => void;

  setStyle: (partial: Partial<StyleConfig>) => void;
  resetStyle: () => void;

  newSession: () => void;
  loadSession: (s: Session) => void;
  getSession: () => Session;

  // Undo/redo history (not persisted). `past`/`future` hold session snapshots;
  // buttons read their lengths to enable/disable.
  past: Session[];
  future: Session[];
  undo: () => void;
  redo: () => void;
  /** Record a history checkpoint at the start of a gesture (e.g. a cluster drag)
   * so the whole gesture collapses to a single undo step. */
  beginHistoryStep: () => void;
}

const persisted = loadPersistedSession();
const initialView = persisted?.view ?? defaultSessionView();

const HISTORY_LIMIT = 50;

export const useStore = create<AppState>((set, get) => {
  // Coalesce rapid same-kind changes (slider/colour-picker drags fire onChange
  // continuously) into one history entry, keyed by an action tag + a short time
  // window. Gesture starts (beginHistoryStep) bypass this by resetting the tag.
  let lastTag: string | null = null;
  let lastTime = 0;
  const COALESCE_MS = 400;

  const pushPast = (tag: string) => {
    const now = Date.now();
    if (tag === lastTag && now - lastTime < COALESCE_MS) {
      lastTime = now;
      return;
    }
    lastTag = tag;
    lastTime = now;
    set((s) => ({ past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT), future: [] }));
  };

  // Wrap a mutating action so it records a pre-mutation checkpoint. `tag` may be a
  // string or a function of the action args (so e.g. per-gene colour edits coalesce
  // per gene, but two different controls stay as separate undo steps).
  // `tag` keys history coalescing; its args are only used to build a string, so it
  // is typed loosely (any[]) to keep A inferred solely from the wrapped action.
  const hist =
    <A extends unknown[]>(tag: string | ((...a: any[]) => string), fn: (...a: A) => void) =>
    (...a: A) => {
      pushPast(typeof tag === "function" ? tag(...a) : tag);
      fn(...a);
    };

  return {
  data: persisted?.data ?? null,
  lanes: initialView.lanes ?? [],
  clusterOffsets: initialView.clusterOffsets ?? {},
  circularClusters: initialView.circularClusters ?? {},
  clusterRotation: initialView.clusterRotation ?? {},
  hiddenClusters: initialView.hiddenClusters ?? {},
  activeMetric: clampMetric(initialView.activeMetric, persisted?.data ?? null),
  colourBy: initialView.colourBy,
  paletteName: initialView.paletteName,
  overrides: initialView.overrides ?? {},
  colourField: initialView.colourField ?? "",
  customGroups: initialView.customGroups ?? [],
  activeCustomGroup: initialView.activeCustomGroup ?? null,
  rowNames: initialView.rowNames ?? {},
  style: { ...DEFAULT_STYLE, ...(initialView.style ?? {}) },
  engine: initialView.engine ?? "parasail",
  mode: initialView.mode ?? "global",
  identityCutoff: initialView.identityCutoff ?? 0.3,
  evalueCutoff: initialView.evalueCutoff ?? 1e-3,
  panelCollapsed: false,
  jobStatus: "idle",
  jobError: null,
  selectedGene: null,
  highlightedLink: null,
  staged: [],
  separateRecords: {},
  past: [],
  future: [],

  // Loading fresh data resets grouping to one cluster per row and clears positions.
  // Custom groups reference gene uids from the previous dataset, so drop them too.
  // A new dataset invalidates prior gene-uid-keyed state, so it clears history too.
  setData: (data) =>
    set((s) => ({
      data,
      lanes: initialLanes(data),
      clusterOffsets: {},
      circularClusters: {},
      clusterRotation: {},
      hiddenClusters: {},
      customGroups: [],
      activeCustomGroup: null,
      // Row names key off cluster uids, which are fresh for each dataset.
      rowNames: {},
      activeMetric: clampMetric(s.activeMetric, data),
      // The inspector's target is a gene uid from the outgoing dataset.
      selectedGene: null,
      past: [],
      future: [],
    })),

  setStaged: (staged) => set({ staged }),
  setSeparateRecords: (name, on) => set((s) => ({ separateRecords: { ...s.separateRecords, [name]: on } })),

  // moveClusterTo / setClusterOffset / setLaneArrangement are the cluster-drag
  // path and deliberately do NOT record history themselves: CanvasView calls
  // beginHistoryStep() once at drag start, so the whole gesture is one undo step.
  //
  // moveClusterTo and setLaneArrangement edit the stored lanes (hidden clusters
  // included) but take lane indices and positions as measured on the canvas,
  // i.e. among visible clusters only.
  moveClusterTo: (uid, target) =>
    set((s) => {
      if (!s.data) return {};
      const hidden = s.hiddenClusters;
      const lanes = effectiveLanes(s.data, s.lanes).map((l) => l.slice());
      // Map visible lane indices before removing anything, so they match what the
      // caller measured.
      const vis = visibleLaneIndices(lanes, hidden);
      // Remove the cluster from its current lane, leaving a (possibly empty)
      // placeholder so lane indices stay aligned with what the caller measured.
      for (const lane of lanes) {
        const i = lane.indexOf(uid);
        if (i >= 0) {
          lane.splice(i, 1);
          break;
        }
      }
      if (target.type === "lane") {
        const lane = lanes[vis[target.lane] ?? -1];
        if (lane) {
          // `pos` counts visible clusters; insert before the pos-th of them.
          const shown = lane.filter((u) => !hidden[u]);
          const at = target.pos < shown.length ? lane.indexOf(shown[Math.max(0, target.pos)]) : lane.length;
          lane.splice(at, 0, uid);
        } else lanes.push([uid]);
      } else {
        const at = target.at < vis.length ? vis[Math.max(0, target.at)] : lanes.length;
        lanes.splice(at, 0, [uid]);
      }
      // Moving to another lane/position changes the cluster's base X, so its
      // stored horizontal offset no longer means anything — drop it.
      const clusterOffsets = { ...s.clusterOffsets };
      delete clusterOffsets[uid];
      return { lanes: lanes.filter((l) => l.length > 0), clusterOffsets };
    }),

  setClusterOffset: (uid, offset) =>
    set((s) => ({ clusterOffsets: { ...s.clusterOffsets, [uid]: offset } })),

  // Mark a cluster circular (or not). Unmarking clears any origin rotation so the
  // sequence returns to its stored orientation.
  toggleClusterCircular: hist((uid) => `circular:${uid}`, (uid) =>
    set((s) => {
      const on = !s.circularClusters[uid];
      const circularClusters = { ...s.circularClusters, [uid]: on };
      if (on) return { circularClusters };
      const clusterRotation = { ...s.clusterRotation };
      delete clusterRotation[uid];
      return { circularClusters, clusterRotation };
    })),

  setAllClustersCircular: hist("circular:all", (on) =>
    set((s) => {
      if (!s.data) return {};
      const circularClusters = Object.fromEntries(s.data.clusters.map((c) => [c.uid, on]));
      return on ? { circularClusters } : { circularClusters, clusterRotation: {} };
    })),

  // Rotate a circular cluster's origin by whole-CDS steps (buildScene wraps genes at
  // gene boundaries, so a step moves the first CDS to the end / vice versa).
  // Wrapped to (−n, n) for an n-gene cluster: a full turn is a no-op, so +n reads
  // as 0 rather than counting up forever. The sign is kept so −1 stays −1.
  rotateCluster: hist((uid) => `rotate:${uid}`, (uid, delta) =>
    set((s) => {
      const cluster = s.data?.clusters.find((c) => c.uid === uid);
      const n = cluster ? cluster.loci.reduce((m, l) => m + l.genes.length, 0) : 0;
      const next = (s.clusterRotation[uid] ?? 0) + delta;
      return { clusterRotation: { ...s.clusterRotation, [uid]: n > 0 ? next % n || 0 : next } };
    })),

  resetAllClusterRotations: hist("rotate:all", () => set({ clusterRotation: {} })),

  toggleClusterHidden: hist((uid) => `hide:${uid}`, (uid) =>
    set((s) => {
      if (!s.data) return {};
      const hide = !s.hiddenClusters[uid];
      if (hide && s.data.clusters.every((c) => c.uid === uid || s.hiddenClusters[c.uid])) return {};
      const hiddenClusters = { ...s.hiddenClusters };
      if (hide) hiddenClusters[uid] = true;
      else delete hiddenClusters[uid];
      // Close the inspector if it shows a gene that just left the figure.
      const cluster = s.data.clusters.find((c) => c.uid === uid);
      const selectedGone = hide && !!s.selectedGene &&
        !!cluster?.loci.some((l) => l.genes.some((g) => g.uid === s.selectedGene));
      return selectedGone ? { hiddenClusters, selectedGene: null } : { hiddenClusters };
    })),

  showAllClusters: hist("hide:all", () => set({ hiddenClusters: {} })),

  // Commit a resolved horizontal arrangement for one lane: reorder its clusters
  // to their final visual left-to-right order and rewrite their offsets so the
  // new sequential base + offset reproduces exactly where they sit now. Keeping
  // array order in sync with visual order is what lets overlap resolution stay
  // continuous after a cluster is dragged past its neighbours (no teleport).
  setLaneArrangement: (laneIndex, order, offsets) =>
    set((s) => {
      if (!s.data) return {};
      const lanes = effectiveLanes(s.data, s.lanes).map((l) => l.slice());
      const stored = visibleLaneIndices(lanes, s.hiddenClusters)[laneIndex];
      if (stored == null) return {};
      lanes[stored] = restoreHiddenInLane(order, lanes[stored], s.hiddenClusters);
      return { lanes, clusterOffsets: { ...s.clusterOffsets, ...offsets } };
    }),

  // Align every cluster's match for the double-clicked gene to that gene's
  // world X, as a single offsets update (one undo-able/persisted change). We
  // rebuild the current scene from the same inputs CanvasView uses so offsets
  // are computed against live geometry (existing offsets + overlap resolution).
  centerClustersOnGene: hist("center", (geneUid) =>
    set((s) => {
      if (!s.data) return {};
      const cfg = makeConfig(s.style);
      const colours = computeColours(s.data, s.colourBy, s.paletteName, s.overrides, s.colourField, s.customGroups);
      const scene = buildScene(s.data, s.lanes, cfg, colours.gene, s.activeMetric, s.clusterOffsets, undefined, [], s.rowNames, s.circularClusters, s.clusterRotation, s.hiddenClusters);
      const clusterOffsets = computeCenteringOffsets(scene, s.data, geneUid, s.clusterOffsets, s.activeMetric);
      return clusterOffsets === s.clusterOffsets ? {} : { clusterOffsets };
    })),

  clearClusterOffsets: hist("clearOffsets", () => set({ clusterOffsets: {} })),

  toggleClusterReversed: hist((uid) => `reverse:${uid}`, (uid) =>
    set((s) => {
      if (!s.data) return {};
      const clusters = s.data.clusters.map((c) => (c.uid === uid ? { ...c, reversed: !c.reversed } : c));
      return { data: { ...s.data, clusters } };
    })),

  renameCluster: hist((uid) => `rename:${uid}`, (uid, name) =>
    set((s) => {
      if (!s.data) return {};
      const clusters = s.data.clusters.map((c) => (c.uid === uid ? { ...c, name } : c));
      return { data: { ...s.data, clusters } };
    })),

  renameGroup: hist((uid) => `renameSimGroup:${uid}`, (uid, label) =>
    set((s) => {
      if (!s.data) return {};
      const groups = s.data.groups.map((g) => (g.uid === uid ? { ...g, label } : g));
      return { data: { ...s.data, groups } };
    })),

  setRowName: hist((key) => `rowname:${key}`, (key, name) =>
    set((s) => {
      const rowNames = { ...s.rowNames };
      // An empty name falls back to the joined member names rather than an empty label.
      if (name.trim()) rowNames[key] = name;
      else delete rowNames[key];
      return { rowNames };
    })),

  setActiveMetric: hist("metric", (activeMetric) => set({ activeMetric })),
  setEngine: hist("engine", (engine) => set({ engine })),
  setMode: hist("mode", (mode) => set({ mode })),
  setIdentityCutoff: hist("identity", (identityCutoff) => set({ identityCutoff })),
  setEvalueCutoff: hist("evalue", (evalueCutoff) => set({ evalueCutoff })),
  togglePanel: () => set((s) => ({ panelCollapsed: !s.panelCollapsed })),
  setJobStatus: (jobStatus, jobError = null) => set({ jobStatus, jobError }),
  selectGene: (selectedGene) => set({ selectedGene }),
  setHighlightedLink: (highlightedLink) => set({ highlightedLink }),

  setColourBy: hist("colourBy", (colourBy) => set({ colourBy })),
  setPaletteName: hist("palette", (paletteName) => set({ paletteName })),
  setOverride: hist((id) => `override:${id}`, (id, colour) => set((s) => ({ overrides: { ...s.overrides, [id]: colour } }))),
  setOverrides: hist("overrides", (overrides) => set({ overrides })),
  clearOverrides: hist("clearOverrides", () => set({ overrides: {} })),

  setColourField: hist("colourField", (colourField) => set({ colourField })),

  addCustomGroup: hist("addGroup", () =>
    set((s) => {
      const id = newGroupId();
      const group: CustomGroup = {
        id,
        label: `Group ${s.customGroups.length + 1}`,
        colour: defaultCustomColour(s.paletteName, s.customGroups.length),
        genes: [],
      };
      return { customGroups: [...s.customGroups, group], activeCustomGroup: id };
    })),

  renameCustomGroup: hist((id) => `renameGroup:${id}`, (id, label) =>
    set((s) => ({ customGroups: s.customGroups.map((g) => (g.id === id ? { ...g, label } : g)) }))),

  setCustomGroupColour: hist((id) => `groupColour:${id}`, (id, colour) =>
    set((s) => ({ customGroups: s.customGroups.map((g) => (g.id === id ? { ...g, colour } : g)) }))),

  removeCustomGroup: hist("removeGroup", (id) =>
    set((s) => ({
      customGroups: s.customGroups.filter((g) => g.id !== id),
      activeCustomGroup: s.activeCustomGroup === id ? null : s.activeCustomGroup,
    }))),

  setActiveCustomGroup: (activeCustomGroup) => set({ activeCustomGroup }),

  // Toggle a gene in the active custom group. A gene belongs to at most one
  // custom group, so adding it here removes it from any other group.
  toggleGeneInCustomGroup: hist((geneUid) => `toggleGene:${geneUid}`, (geneUid) =>
    set((s) => {
      const targetId = s.activeCustomGroup;
      if (!targetId) return {};
      const target = s.customGroups.find((g) => g.id === targetId);
      if (!target) return {};
      const has = target.genes.includes(geneUid);
      const customGroups = s.customGroups.map((g) => {
        if (g.id === targetId) {
          return { ...g, genes: has ? g.genes.filter((u) => u !== geneUid) : [...g.genes, geneUid] };
        }
        if (!has && g.genes.includes(geneUid)) {
          return { ...g, genes: g.genes.filter((u) => u !== geneUid) };
        }
        return g;
      });
      return { customGroups };
    })),

  // Coalesce per changed key so dragging one slider is a single undo step, while
  // two different controls stay separate.
  setStyle: hist((partial) => `style:${Object.keys(partial).sort().join(",")}`, (partial) =>
    set((s) => ({ style: { ...s.style, ...partial } }))),
  resetStyle: hist("resetStyle", () => set({ style: { ...DEFAULT_STYLE } })),

  // Session-level resets are history barriers: they clear the undo/redo stacks.
  newSession: () =>
    set({ data: null, lanes: [], clusterOffsets: {}, circularClusters: {}, clusterRotation: {}, hiddenClusters: {}, overrides: {}, customGroups: [], activeCustomGroup: null, rowNames: {}, jobStatus: "idle", jobError: null, selectedGene: null, staged: [], separateRecords: {}, past: [], future: [] }),

  loadSession: (session) => set({ ...sessionToState(session), selectedGene: null, past: [], future: [] }),

  getSession: () => snapshotOf(get()),

  undo: () =>
    set((s) => {
      if (!s.past.length) return {};
      const prev = s.past[s.past.length - 1];
      const current = snapshotOf(s);
      return { ...sessionToState(prev), selectedGene: selectionAfter(s.selectedGene, prev), past: s.past.slice(0, -1), future: [current, ...s.future].slice(0, HISTORY_LIMIT) };
    }),

  redo: () =>
    set((s) => {
      if (!s.future.length) return {};
      const next = s.future[0];
      const current = snapshotOf(s);
      return { ...sessionToState(next), selectedGene: selectionAfter(s.selectedGene, next), future: s.future.slice(1), past: [...s.past, current].slice(-HISTORY_LIMIT) };
    }),

  beginHistoryStep: () => {
    // A fresh gesture: force a checkpoint (bypass coalescing) capturing the state
    // before any offsets change, and drop the redo stack.
    lastTag = null;
    set((s) => ({ past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT), future: [] }));
  },
  };
});

useStore.subscribe((state, prev) => {
  const session = state.getSession();
  // Transient changes (hover highlights, selection, job status) leave every session
  // field untouched; skip re-serialising the whole dataset for them.
  const before = snapshotOf(prev);
  const unchanged =
    session.data === before.data &&
    (Object.keys(session.view) as (keyof SessionView)[]).every((k) => session.view[k] === before.view[k]);
  if (unchanged) return;
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
});
