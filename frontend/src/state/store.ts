import { create } from "zustand";
import type { FigureData, MetricKey } from "../types";
import { DEFAULT_PALETTE, PALETTES, computeColours, type ColourBy, type CustomGroup } from "../render/palette";
import { DEFAULT_STYLE, makeConfig, type StyleConfig } from "../render/style";
import { availableMetrics, buildScene, computeCenteringOffsets, effectiveLanes } from "../render/layout";

/** A drop target for moving a cluster: into an existing lane, or a brand-new lane. */
export type MoveTarget =
  | { type: "lane"; lane: number; pos: number }
  | { type: "new"; at: number };

export interface SessionView {
  lanes: string[][];
  /** Per-cluster horizontal shift (world px) applied on top of sequential lane packing. */
  clusterOffsets: Record<string, number>;
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
    activeMetric: "identity",
    colourBy: "group",
    paletteName: DEFAULT_PALETTE,
    overrides: {},
    colourField: "",
    customGroups: [],
    activeCustomGroup: null,
    style: { ...DEFAULT_STYLE },
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

function singletonLanes(data: FigureData | null): string[][] {
  return data ? data.clusters.map((c) => [c.uid]) : [];
}

interface AppState extends SessionView {
  data: FigureData | null;
  panelCollapsed: boolean;
  jobStatus: string;

  setData: (d: FigureData | null) => void;
  moveClusterTo: (uid: string, target: MoveTarget) => void;
  setClusterOffset: (uid: string, offset: number) => void;
  setLaneArrangement: (laneIndex: number, order: string[], offsets: Record<string, number>) => void;
  centerClustersOnGene: (geneUid: string) => void;
  clearClusterOffsets: () => void;
  toggleClusterReversed: (uid: string) => void;
  renameCluster: (uid: string, name: string) => void;
  setActiveMetric: (m: MetricKey) => void;
  setEngine: (engine: string) => void;
  setMode: (mode: string) => void;
  setIdentityCutoff: (v: number) => void;
  setEvalueCutoff: (v: number) => void;
  togglePanel: () => void;
  setJobStatus: (s: string) => void;

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
}

const persisted = loadPersistedSession();
const initialView = persisted?.view ?? defaultSessionView();

export const useStore = create<AppState>((set, get) => ({
  data: persisted?.data ?? null,
  lanes: initialView.lanes ?? [],
  clusterOffsets: initialView.clusterOffsets ?? {},
  activeMetric: clampMetric(initialView.activeMetric, persisted?.data ?? null),
  colourBy: initialView.colourBy,
  paletteName: initialView.paletteName,
  overrides: initialView.overrides ?? {},
  colourField: initialView.colourField ?? "",
  customGroups: initialView.customGroups ?? [],
  activeCustomGroup: initialView.activeCustomGroup ?? null,
  style: { ...DEFAULT_STYLE, ...(initialView.style ?? {}) },
  engine: initialView.engine ?? "parasail",
  mode: initialView.mode ?? "global",
  identityCutoff: initialView.identityCutoff ?? 0.3,
  evalueCutoff: initialView.evalueCutoff ?? 1e-3,
  panelCollapsed: false,
  jobStatus: "idle",

  // Loading fresh data resets grouping to one cluster per row and clears positions.
  // Custom groups reference gene uids from the previous dataset, so drop them too.
  setData: (data) =>
    set((s) => ({
      data,
      lanes: singletonLanes(data),
      clusterOffsets: {},
      customGroups: [],
      activeCustomGroup: null,
      activeMetric: clampMetric(s.activeMetric, data),
    })),

  moveClusterTo: (uid, target) =>
    set((s) => {
      if (!s.data) return {};
      const lanes = effectiveLanes(s.data, s.lanes).map((l) => l.slice());
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
        const lane = lanes[target.lane];
        if (lane) lane.splice(Math.max(0, Math.min(target.pos, lane.length)), 0, uid);
        else lanes.push([uid]);
      } else {
        lanes.splice(Math.max(0, Math.min(target.at, lanes.length)), 0, [uid]);
      }
      // Moving to another lane/position changes the cluster's base X, so its
      // stored horizontal offset no longer means anything — drop it.
      const clusterOffsets = { ...s.clusterOffsets };
      delete clusterOffsets[uid];
      return { lanes: lanes.filter((l) => l.length > 0), clusterOffsets };
    }),

  setClusterOffset: (uid, offset) =>
    set((s) => ({ clusterOffsets: { ...s.clusterOffsets, [uid]: offset } })),

  // Commit a resolved horizontal arrangement for one lane: reorder its clusters
  // to their final visual left-to-right order and rewrite their offsets so the
  // new sequential base + offset reproduces exactly where they sit now. Keeping
  // array order in sync with visual order is what lets overlap resolution stay
  // continuous after a cluster is dragged past its neighbours (no teleport).
  setLaneArrangement: (laneIndex, order, offsets) =>
    set((s) => {
      if (!s.data) return {};
      const lanes = effectiveLanes(s.data, s.lanes).map((l) => l.slice());
      if (laneIndex < 0 || laneIndex >= lanes.length) return {};
      lanes[laneIndex] = order;
      return { lanes, clusterOffsets: { ...s.clusterOffsets, ...offsets } };
    }),

  // Align every cluster's homolog of the double-clicked gene to that gene's
  // world X, as a single offsets update (one undo-able/persisted change). We
  // rebuild the current scene from the same inputs CanvasView uses so offsets
  // are computed against live geometry (existing offsets + overlap resolution).
  centerClustersOnGene: (geneUid) =>
    set((s) => {
      if (!s.data) return {};
      const cfg = makeConfig(s.style);
      const colours = computeColours(s.data, s.colourBy, s.paletteName, s.overrides, s.colourField, s.customGroups);
      const scene = buildScene(s.data, s.lanes, cfg, colours.gene, s.activeMetric, s.clusterOffsets);
      const clusterOffsets = computeCenteringOffsets(scene, s.data, geneUid, s.clusterOffsets, s.activeMetric);
      return clusterOffsets === s.clusterOffsets ? {} : { clusterOffsets };
    }),

  clearClusterOffsets: () => set({ clusterOffsets: {} }),

  toggleClusterReversed: (uid) =>
    set((s) => {
      if (!s.data) return {};
      const clusters = s.data.clusters.map((c) => (c.uid === uid ? { ...c, reversed: !c.reversed } : c));
      return { data: { ...s.data, clusters } };
    }),

  renameCluster: (uid, name) =>
    set((s) => {
      if (!s.data) return {};
      const clusters = s.data.clusters.map((c) => (c.uid === uid ? { ...c, name } : c));
      return { data: { ...s.data, clusters } };
    }),

  setActiveMetric: (activeMetric) => set({ activeMetric }),
  setEngine: (engine) => set({ engine }),
  setMode: (mode) => set({ mode }),
  setIdentityCutoff: (identityCutoff) => set({ identityCutoff }),
  setEvalueCutoff: (evalueCutoff) => set({ evalueCutoff }),
  togglePanel: () => set((s) => ({ panelCollapsed: !s.panelCollapsed })),
  setJobStatus: (jobStatus) => set({ jobStatus }),

  setColourBy: (colourBy) => set({ colourBy }),
  setPaletteName: (paletteName) => set({ paletteName }),
  setOverride: (id, colour) => set((s) => ({ overrides: { ...s.overrides, [id]: colour } })),
  setOverrides: (overrides) => set({ overrides }),
  clearOverrides: () => set({ overrides: {} }),

  setColourField: (colourField) => set({ colourField }),

  addCustomGroup: () =>
    set((s) => {
      const id = newGroupId();
      const group: CustomGroup = {
        id,
        label: `Group ${s.customGroups.length + 1}`,
        colour: defaultCustomColour(s.paletteName, s.customGroups.length),
        genes: [],
      };
      return { customGroups: [...s.customGroups, group], activeCustomGroup: id };
    }),

  renameCustomGroup: (id, label) =>
    set((s) => ({ customGroups: s.customGroups.map((g) => (g.id === id ? { ...g, label } : g)) })),

  setCustomGroupColour: (id, colour) =>
    set((s) => ({ customGroups: s.customGroups.map((g) => (g.id === id ? { ...g, colour } : g)) })),

  removeCustomGroup: (id) =>
    set((s) => ({
      customGroups: s.customGroups.filter((g) => g.id !== id),
      activeCustomGroup: s.activeCustomGroup === id ? null : s.activeCustomGroup,
    })),

  setActiveCustomGroup: (activeCustomGroup) => set({ activeCustomGroup }),

  // Toggle a gene in the active custom group. A gene belongs to at most one
  // custom group, so adding it here removes it from any other group.
  toggleGeneInCustomGroup: (geneUid) =>
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
    }),

  setStyle: (partial) => set((s) => ({ style: { ...s.style, ...partial } })),
  resetStyle: () => set({ style: { ...DEFAULT_STYLE } }),

  newSession: () =>
    set({ data: null, lanes: [], clusterOffsets: {}, overrides: {}, customGroups: [], activeCustomGroup: null, jobStatus: "idle" }),

  loadSession: (session) =>
    set({
      data: session.data,
      lanes: session.view.lanes ?? singletonLanes(session.data),
      clusterOffsets: session.view.clusterOffsets ?? {},
      activeMetric: clampMetric(session.view.activeMetric, session.data),
      colourBy: session.view.colourBy,
      paletteName: session.view.paletteName,
      overrides: session.view.overrides ?? {},
      colourField: session.view.colourField ?? "",
      customGroups: session.view.customGroups ?? [],
      activeCustomGroup: session.view.activeCustomGroup ?? null,
      style: { ...DEFAULT_STYLE, ...(session.view.style ?? {}) },
      engine: session.view.engine ?? "parasail",
      mode: session.view.mode ?? "global",
      identityCutoff: session.view.identityCutoff ?? 0.3,
      evalueCutoff: session.view.evalueCutoff ?? 1e-3,
      jobStatus: "idle",
    }),

  getSession: () => {
    const s = get();
    return {
      schemaVersion: 1,
      data: s.data,
      view: {
        lanes: s.lanes,
        clusterOffsets: s.clusterOffsets,
        activeMetric: s.activeMetric,
        colourBy: s.colourBy,
        paletteName: s.paletteName,
        overrides: s.overrides,
        colourField: s.colourField,
        customGroups: s.customGroups,
        activeCustomGroup: s.activeCustomGroup,
        style: s.style,
        engine: s.engine,
        mode: s.mode,
        identityCutoff: s.identityCutoff,
        evalueCutoff: s.evalueCutoff,
      },
    };
  },
}));

useStore.subscribe((state) => {
  const session = state.getSession();
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
});
