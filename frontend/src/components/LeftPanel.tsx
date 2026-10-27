import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HexColorInput, HexColorPicker } from "react-colorful";
import { useStore } from "../state/store";
import { errorMessage, fetchCapabilities, loadExampleSession } from "../api";
import { GENBANK_RE, useUpload } from "../state/useUpload";
import { availableFields, computeColours, hiddenGeneUids, OTHER_ID, PALETTE_NAMES, type ColourBy } from "../render/palette";
import {
  availableMetrics,
  CUSTOM_GROUP_LABEL_FIELD,
  effectiveLanes,
  geneAaLengths,
  hasPartialSpans,
  linkFragmentAa,
  metricLowerIsBetter,
  type GeneShapeKind,
} from "../render/layout";
import { download } from "../download";
import type { FigureData, MetricKey } from "../types";

const GENE_SHAPES: { value: GeneShapeKind; label: string }[] = [
  { value: "triangle", label: "Triangle" },
  { value: "arrow", label: "Arrow" },
  { value: "rounded", label: "Rounded block" },
  { value: "box", label: "Box" },
];

// One-line explanation of each similarity metric, shown under the selector.
const METRIC_INFO: Record<MetricKey, string> = {
  identity: "Fraction of identical residues across the aligned region (0–1). Higher = closer match.",
  similarity: "Fraction of identical or chemically similar residues (0–1). Higher = closer match.",
  coverage: "Fraction of the sequence length spanned by the alignment (0–1). Higher = more complete hit.",
  bitscore: "Length- and substitution-aware alignment score. Higher = stronger match (unbounded).",
  evalue: "Expected number of hits this strong by chance. Lower (nearer 0) = more significant.",
  jaccard: "Jaccard index of shared content (0–1). Higher = more similar.",
};

// Segment captions for "Colour by". The "cluster" mode colours each row, which the
// UI calls a sequence everywhere else.
const COLOUR_BY_LABEL: Record<ColourBy, string> = { group: "Group", cluster: "Sequence", field: "Field", custom: "Custom" };

const METRIC_LABEL: Record<MetricKey, string> = {
  identity: "identity",
  similarity: "similarity",
  coverage: "coverage",
  bitscore: "bit score",
  evalue: "E-value",
  jaccard: "Jaccard",
};

// Capitalised labels for the metric dropdown.
const METRIC_OPTION_LABEL: Record<MetricKey, string> = {
  identity: "Identity",
  similarity: "Similarity",
  coverage: "Coverage",
  bitscore: "Bit score",
  evalue: "E-value",
  jaccard: "Jaccard",
};

/**
 * Slider bounds for the link threshold in the active metric's own units.
 * Fraction metrics are fixed to 0–1; bitscore/E-value ranges are derived from
 * the loaded links so the slider spans what the data actually contains.
 */
function metricRange(metric: MetricKey, data: FigureData | null) {
  const lower = metricLowerIsBetter(metric);
  const bounded01 = metric === "identity" || metric === "similarity" || metric === "coverage" || metric === "jaccard";
  let lo = 0;
  let hi = 1;
  if (!bounded01) {
    let dmin = Infinity;
    let dmax = -Infinity;
    for (const l of data?.links ?? []) {
      const v = l.metrics[metric];
      if (typeof v === "number") {
        if (v < dmin) dmin = v;
        if (v > dmax) dmax = v;
      }
    }
    if (isFinite(dmin) && isFinite(dmax) && dmax > dmin) {
      lo = Math.min(0, dmin);
      hi = dmax;
    } else {
      lo = 0;
      hi = metric === "bitscore" ? 1000 : 1;
    }
  }
  const span = hi - lo || 1;
  const step = bounded01 ? 0.01 : metric === "bitscore" ? Math.max(1, Math.round(span / 100)) : span / 100;
  // "Show everything" sits at the permissive end of the range.
  const showAll = lower ? hi : lo;
  return { lo, hi, step, lower, showAll };
}

// Bottom padding on the scroll container that is only as tall as needed to keep
// the current scroll position valid. Collapsing a section near the bottom would
// otherwise clamp scrollTop and shove the whole menu down; the padding holds the
// clicked header still, then melts away as the user scrolls back up.
function fitScrollPad(scroller: HTMLElement, holdScrollTop: number) {
  const pad = parseFloat(scroller.style.paddingBottom) || 0;
  const content = scroller.scrollHeight - pad;
  const needed = Math.max(0, holdScrollTop + scroller.clientHeight - content);
  if (needed !== pad) scroller.style.paddingBottom = needed ? `${needed}px` : "";
}

// Open/closed state for a collapsible header that stays put under the cursor
// when toggled. Only content below the header changes, so restoring the old
// scrollTop (after padding for it) keeps the header exactly where it was.
function usePinnedToggle(defaultOpen?: boolean) {
  const [open, setOpen] = useState(!!defaultOpen);
  const headerRef = useRef<HTMLButtonElement>(null);
  const held = useRef<number | null>(null);
  const toggle = () => {
    held.current = headerRef.current?.closest<HTMLElement>(".left-panel")?.scrollTop ?? null;
    setOpen((o) => !o);
  };
  useLayoutEffect(() => {
    const scroller = headerRef.current?.closest<HTMLElement>(".left-panel");
    if (held.current === null || !scroller) return;
    fitScrollPad(scroller, held.current);
    scroller.scrollTop = held.current;
    held.current = null;
  }, [open]);
  return { open, toggle, headerRef };
}

function Section({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const { open, toggle, headerRef } = usePinnedToggle(defaultOpen);
  return (
    <div className={"section" + (open ? " open" : "")}>
      <button ref={headerRef} className="section-header" onClick={toggle} aria-expanded={open}>
        <span className="chevron" aria-hidden="true">▸</span>
        {title}
      </button>
      {open && <div className="section-body">{children ?? <p className="muted">Controls coming soon.</p>}</div>}
    </div>
  );
}

function Subsection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const { open, toggle, headerRef } = usePinnedToggle(defaultOpen);
  return (
    <div className={"subsection" + (open ? " open" : "")}>
      <button ref={headerRef} className="subsection-header" onClick={toggle} aria-expanded={open}>
        <span>{title}</span>
        <span className="subsection-chevron" aria-hidden="true">▸</span>
      </button>
      {open && <div className="subsection-body">{children}</div>}
    </div>
  );
}

// A bounded numeric field: a range slider paired with a manual number input.
// The two stay in sync; manual entry is clamped to [min, max] so the value
// always stays valid for rendering.
function SliderField(p: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const step = p.step ?? 1;
  const clamp = (v: number) => (isNaN(v) ? p.min : Math.min(p.max, Math.max(p.min, v)));
  return (
    <div className={`field slider-field${p.disabled ? " is-disabled" : ""}`}>
      <div className="slider-head">
        <span>{p.label}</span>
        <input
          type="number"
          className="slider-num"
          value={p.value}
          min={p.min}
          max={p.max}
          step={step}
          disabled={p.disabled}
          onChange={(e) => p.onChange(clamp(+e.target.value))}
        />
      </div>
      <input
        type="range"
        value={p.value}
        min={p.min}
        max={p.max}
        step={step}
        disabled={p.disabled}
        onChange={(e) => p.onChange(+e.target.value)}
      />
    </div>
  );
}

function SelectField<T extends string>(p: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  disabled?: boolean;
  onChange: (v: T) => void;
}) {
  return (
    <label className={`field-inline${p.disabled ? " is-disabled" : ""}`}>
      <span>{p.label}</span>
      <select value={p.value} disabled={p.disabled} onChange={(e) => p.onChange(e.target.value as T)}>
        {p.options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

// Swatch that opens a small picker with a hex field. Replaces <input type="color">,
// whose native dialog can't be restyled (Chrome's opens on RGB number boxes).
// The popover is portalled to <body> with fixed positioning so the scrolling
// panel can't clip it; it closes on outside click, Escape, scroll or resize.
function ColourSwatch(p: { value: string; title?: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Place below the swatch, flipping above when it would run off the bottom.
  useLayoutEffect(() => {
    const btn = btnRef.current;
    const pop = popRef.current;
    if (!open || !btn || !pop) return;
    const r = btn.getBoundingClientRect();
    const h = pop.offsetHeight;
    const below = r.bottom + 6;
    pop.style.left = `${Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)}px`;
    pop.style.top = `${below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below}px`;
    pop.querySelector<HTMLInputElement>("input")?.select();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) =>
      t instanceof Node && (!!popRef.current?.contains(t) || !!btnRef.current?.contains(t));
    const onDown = (e: PointerEvent) => !inside(e.target) && setOpen(false);
    const onScroll = (e: Event) => !inside(e.target) && setOpen(false);
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="swatch-input"
        style={{ background: p.value }}
        title={p.title}
        aria-label={p.title ?? "Choose colour"}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      />
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="colour-popover"
            // Keep keys (arrows on the sliders, Escape) away from the canvas's
            // window-level pan/zoom/deselect shortcuts.
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape" || e.key === "Enter") {
                setOpen(false);
                btnRef.current?.focus();
              }
            }}
          >
            <HexColorPicker color={p.value} onChange={p.onChange} />
            <label className="colour-hex">
              <span>#</span>
              <HexColorInput color={p.value} onChange={(v) => p.onChange(expandHex(v))} aria-label="Hex colour" />
            </label>
          </div>,
          document.body,
        )}
    </>
  );
}

// HexColorInput accepts shorthand ("#abc"); store the full form like the picker does.
function expandHex(v: string) {
  const h = v.replace("#", "").toLowerCase();
  return "#" + (h.length === 3 ? h.replace(/./g, "$&$&") : h);
}

function ColourField(p: { label: string; value: string; onChange: (v: string) => void }) {
  // A div, not a <label>: clicking the caption would otherwise re-toggle the popover.
  return (
    <div className="field-inline">
      <span>{p.label}</span>
      <ColourSwatch value={p.value} title={p.label} onChange={p.onChange} />
    </div>
  );
}

function CheckField(p: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`field-inline${p.disabled ? " is-disabled" : ""}`}>
      <span>{p.label}</span>
      <input type="checkbox" checked={p.checked} disabled={p.disabled} onChange={(e) => p.onChange(e.target.checked)} />
    </label>
  );
}

// Editor for hand-built colour groups. Users create groups here, make one active,
// then click genes on the figure (CanvasView) to add/remove them. Each group owns
// its colour directly, so there are no palette/override rows in this mode.
function CustomColourEditor() {
  const customGroups = useStore((s) => s.customGroups);
  const activeCustomGroup = useStore((s) => s.activeCustomGroup);
  const addCustomGroup = useStore((s) => s.addCustomGroup);
  const renameCustomGroup = useStore((s) => s.renameCustomGroup);
  const setCustomGroupColour = useStore((s) => s.setCustomGroupColour);
  const removeCustomGroup = useStore((s) => s.removeCustomGroup);
  const setActiveCustomGroup = useStore((s) => s.setActiveCustomGroup);

  return (
    <div className="custom-groups">
      <p className="muted">
        Create a group, click its dot to make it active, then click genes in the figure to add or remove them.
        Each gene belongs to at most one group.
      </p>
      {customGroups.map((g) => {
        const active = g.id === activeCustomGroup;
        return (
          <div className={"custom-group-row" + (active ? " active" : "")} key={g.id}>
            <button
              className={"custom-active-toggle" + (active ? " on" : "")}
              title={active ? "Active — click genes to assign" : "Make active"}
              onClick={() => setActiveCustomGroup(active ? null : g.id)}
            >
              {active ? "●" : "○"}
            </button>
            <ColourSwatch value={g.colour} title="Group colour" onChange={(v) => setCustomGroupColour(g.id, v)} />
            <input
              className="custom-group-name"
              value={g.label}
              onChange={(e) => renameCustomGroup(g.id, e.target.value)}
            />
            <span className="legend-count">{g.genes.length}</span>
            <button className="custom-group-del" title="Delete group" onClick={() => removeCustomGroup(g.id)}>
              ×
            </button>
          </div>
        );
      })}
      <button className="btn btn-block" onClick={addCustomGroup}>+ New group</button>
      {!customGroups.length && (
        <p className="muted">No groups yet. Add one to start colouring genes by hand.</p>
      )}
    </div>
  );
}

// A plasmid-map ring with a dot marking the origin: the per-sequence "circular"
// toggle. Deliberately not an arrow, so it can't be mistaken for the reset-origin
// icon beside it.
function CircularIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="2.5" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Vertical double arrow: extra space above a sequence's row.
function SpaceIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2v12" />
      <path d="M5 4.5 8 2l3 2.5" />
      <path d="M5 11.5 8 14l3-2.5" />
    </svg>
  );
}

// Counter-clockwise arrow: restore a circular sequence's original origin.
function ResetIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.8 6.5A5.2 5.2 0 1 1 3 10.4" />
      <path d="M2.5 2.8v3.9h3.9" />
    </svg>
  );
}

export default function LeftPanel() {
  const data = useStore((s) => s.data);
  const loadSession = useStore((s) => s.loadSession);
  const setJobStatus = useStore((s) => s.setJobStatus);
  const jobError = useStore((s) => s.jobError);
  const activeMetric = useStore((s) => s.activeMetric);
  const setActiveMetric = useStore((s) => s.setActiveMetric);
  const engine = useStore((s) => s.engine);
  const setEngine = useStore((s) => s.setEngine);
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const identityCutoff = useStore((s) => s.identityCutoff);
  const setIdentityCutoff = useStore((s) => s.setIdentityCutoff);
  const evalueCutoff = useStore((s) => s.evalueCutoff);
  const setEvalueCutoff = useStore((s) => s.setEvalueCutoff);
  const colourBy = useStore((s) => s.colourBy);
  const setColourBy = useStore((s) => s.setColourBy);
  const paletteName = useStore((s) => s.paletteName);
  const setPaletteName = useStore((s) => s.setPaletteName);
  const overrides = useStore((s) => s.overrides);
  const setOverride = useStore((s) => s.setOverride);
  const setOverrides = useStore((s) => s.setOverrides);
  const clearOverrides = useStore((s) => s.clearOverrides);
  const renameGroup = useStore((s) => s.renameGroup);
  const colourField = useStore((s) => s.colourField);
  const setColourField = useStore((s) => s.setColourField);
  const customGroups = useStore((s) => s.customGroups);
  const style = useStore((s) => s.style);
  const setStyle = useStore((s) => s.setStyle);
  const resetStyle = useStore((s) => s.resetStyle);
  const clusterOffsets = useStore((s) => s.clusterOffsets);
  const clearClusterOffsets = useStore((s) => s.clearClusterOffsets);
  const hasOffsets = Object.values(clusterOffsets).some((v) => v !== 0);
  const circularClusters = useStore((s) => s.circularClusters);
  const clusterRotation = useStore((s) => s.clusterRotation);
  const toggleClusterCircular = useStore((s) => s.toggleClusterCircular);
  const setAllClustersCircular = useStore((s) => s.setAllClustersCircular);
  const rotateCluster = useStore((s) => s.rotateCluster);
  const resetAllClusterRotations = useStore((s) => s.resetAllClusterRotations);
  const clusterSpaceAbove = useStore((s) => s.clusterSpaceAbove);
  const setClusterSpaceAbove = useStore((s) => s.setClusterSpaceAbove);
  const resetAllClusterSpaceAbove = useStore((s) => s.resetAllClusterSpaceAbove);
  const hiddenClusters = useStore((s) => s.hiddenClusters);
  const lanes = useStore((s) => s.lanes);
  const toggleClusterHidden = useStore((s) => s.toggleClusterHidden);
  const showAllClusters = useStore((s) => s.showAllClusters);

  const [drag, setDrag] = useState(false);
  const [sequenceFilter, setSequenceFilter] = useState("");
  // Sequence whose "space above" slider is expanded in the list (one at a time).
  const [spacingOpen, setSpacingOpen] = useState<string | null>(null);
  // Shared upload flow: selection stages files; the explicit "Run" button below
  // the alignment settings starts the job, so method/thresholds can be set first.
  const { staged, stageFiles, runStaged, clearStaged, loading } = useUpload();
  const separateRecords = useStore((s) => s.separateRecords);
  const setSeparateRecords = useStore((s) => s.setSeparateRecords);
  const [exampleLoading, setExampleLoading] = useState(false);
  // Engines this deployment can run. parasail (the default) is always present;
  // DIAMOND appears only where its binary is on PATH (pixi env / the Docker image).
  const [engines, setEngines] = useState<string[]>(["parasail"]);

  useEffect(() => {
    fetchCapabilities()
      .then((c) => {
        setEngines(c.engines);
        // If a persisted session selected an engine this server can't run, fall
        // back to its default so the next upload doesn't fail.
        if (!c.engines.includes(useStore.getState().engine)) setEngine(c.defaultEngine);
      })
      .catch(() => setEngines(["parasail"]));
  }, [setEngine]);

  const geneCount = data
    ? data.clusters.reduce((n, c) => n + c.loci.reduce((m, l) => m + l.genes.length, 0), 0)
    : 0;
  const items = data ? computeColours(data, colourBy, paletteName, overrides, colourField, customGroups, style.maxLegendEntries, hiddenGeneUids(data, hiddenClusters)).items : [];
  const fields = data ? availableFields(data) : [];

  // When switching to "field" mode, pick a sensible default qualifier if none is
  // chosen yet (product/function are the usual annotation fields), so the figure
  // recolours immediately instead of showing everything as ungrouped.
  const onColourByChange = (c: ColourBy) => {
    if (c === "field" && !fields.includes(colourField)) {
      const preferred = ["product", "function", "gene", "note"].find((f) => fields.includes(f));
      setColourField(preferred ?? fields[0] ?? "");
    }
    setColourBy(c);
  };

  // Link-threshold slider bounds follow the active metric's units; the stored
  // value is clamped into range so switching metrics never leaves it stranded.
  const mr = metricRange(activeMetric, data);
  const threshold = Math.min(mr.hi, Math.max(mr.lo, style.linkThreshold));

  // Switching metric resets the threshold to "show all" for the new metric,
  // since a cutoff in one metric's units is meaningless in another's.
  const onMetricChange = (m: MetricKey) => {
    setActiveMetric(m);
    setStyle({ linkThreshold: metricRange(m, data).showAll });
  };

  // Only offer the metrics the loaded alignment actually populated (DIAMOND: all;
  // parasail: identity/similarity/coverage). Fall back to the full set with no data.
  const metricAvail = availableMetrics(data);
  const metricChoices: MetricKey[] = metricAvail.length
    ? metricAvail
    : ["identity", "similarity", "coverage", "bitscore", "evalue"];

  // Min-fragment-length filter applies only to partial (parasail-local) links.
  const spanned = hasPartialSpans(data);
  const fragMax = (() => {
    if (!spanned || !data) return 0;
    const aaLens = geneAaLengths(data);
    let max = 0;
    for (const l of data.links) {
      const f = linkFragmentAa(l, aaLens);
      if (f != null && f > max) max = f;
    }
    return Math.max(10, Math.ceil(max));
  })();
  const minFragment = Math.min(fragMax, style.minFragmentAa);
  // List sequences in figure order (rows top to bottom, left to right within a row).
  // Hidden ones keep their stored place in `lanes`, so they stay where they'll reappear.
  const byUid = new Map(data?.clusters.map((c) => [c.uid, c]) ?? []);
  const orderedClusters = data ? effectiveLanes(data, lanes).flat().map((u) => byUid.get(u)!) : [];
  const filteredClusters = orderedClusters.filter((c) => c.name.toLowerCase().includes(sequenceFilter.trim().toLowerCase()));
  const circularCount = data?.clusters.filter((c) => circularClusters[c.uid]).length ?? 0;
  const hiddenCount = data?.clusters.filter((c) => hiddenClusters[c.uid]).length ?? 0;
  const shownCount = (data?.clusters.length ?? 0) - hiddenCount;
  const hasRotations = Object.values(clusterRotation).some((v) => v !== 0);
  const hasSpaceAbove = Object.values(clusterSpaceAbove).some((v) => v !== 0);

  // loadSession clears the staged queue, so the example replaces any pending files.
  const loadExample = async () => {
    setExampleLoading(true);
    try {
      loadSession(await loadExampleSession(setJobStatus));
      setJobStatus("idle");
    } catch (e) {
      setJobStatus("failed", errorMessage(e));
      console.error(e);
    } finally {
      setExampleLoading(false);
    }
  };

  const exportColourCSV = () => {
    const csv = ["label,colour", ...items.map((i) => `${i.label},${i.colour}`)].join("\n");
    download(new Blob([csv], { type: "text/csv" }), "weft-colours.csv");
  };

  const importColourCSV = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const byLabel = new Map(items.map((i) => [i.label, i.id]));
    const next = { ...overrides };
    text.split(/\r?\n/).forEach((line) => {
      const [label, colour] = line.split(",");
      const id = label && byLabel.get(label.trim());
      if (id && colour) next[id] = colour.trim();
    });
    setOverrides(next);
    e.target.value = "";
  };

  // One-line description of the selected method, shown under the picker.
  const methodHint =
    engine === "parasail"
      ? mode === "local"
        ? "Exact pairwise — finds shared sub-regions (domains)."
        : "Exact pairwise — whole-protein comparison."
      : "Fast heuristic search — best for large datasets.";

  const runLabel = loading
    ? "Running…"
    : staged.length === 0
      ? "Add files to run"
      : `Run alignment on ${staged.length} file${staged.length === 1 ? "" : "s"}`;

  return (
    <aside className="left-panel" onScroll={(e) => fitScrollPad(e.currentTarget, e.currentTarget.scrollTop)}>
      <Section key={data ? "data-loaded" : "data-empty"} title="Data & alignment" defaultOpen={!data}>
        <div className="flat-group upload-flow">
          {/* 1 — Input */}
          <label
            className={"dropzone" + (drag ? " drag" : "")}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); stageFiles(e.dataTransfer.files); }}
          >
            <span className="dropzone-title">Drop files to align</span>
            <span className="dropzone-sub">GenBank or GFF3/GTF + FASTA — or click to browse</span>
            <input type="file" accept=".gbk,.gb,.genbank,.gbf,.gbff,.gff,.gff3,.gtf,.fa,.fna,.fasta,.fas,.faa" multiple hidden onChange={(e) => { stageFiles(e.target.files); e.target.value = ""; }} />
          </label>
          <div className="upload-actions">
            <label className="btn btn-sm">
              Folder…
              <input
                type="file"
                multiple
                hidden
                // @ts-expect-error non-standard attribute supported by Chromium-based browsers
                webkitdirectory=""
                onChange={(e) => { stageFiles(e.target.files); e.target.value = ""; }}
              />
            </label>
            <button className="btn btn-sm" onClick={loadExample} disabled={loading || exampleLoading}>
              {exampleLoading ? "Loading…" : "Example"}
            </button>
          </div>

          {staged.length > 0 && (
            <div className="staged">
              <div className="staged-head">
                <span>{staged.length} file{staged.length === 1 ? "" : "s"} staged</span>
                <button className="link-btn" onClick={clearStaged} disabled={loading}>Clear</button>
              </div>
              <ul className="staged-list">
                {staged.map((f) => (
                  <li key={f.name} className="staged-file">
                    <span className="staged-name">{f.name}</span>
                    {GENBANK_RE.test(f.name) && (
                      <label
                        className="split-toggle"
                        title="Make each record (e.g. each contig of a draft assembly) its own sequence, so it can be moved and flipped on its own. Off: the file is one sequence."
                      >
                        <input
                          type="checkbox"
                          checked={!!separateRecords[f.name]}
                          disabled={loading}
                          onChange={(e) => setSeparateRecords(f.name, e.target.checked)}
                        />
                        Split records
                      </label>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 2 — Method */}
          <div className="flat-divider" />
          <label className="field compact-field">
            <span>Alignment method</span>
            <select
              value={engine === "parasail" ? `parasail-${mode}` : engine}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "diamond") setEngine(v);
                else {
                  setEngine("parasail");
                  setMode(v === "parasail-local" ? "local" : "global");
                }
              }}
            >
              <option value="parasail-global">Global — compare whole proteins</option>
              <option value="parasail-local">Local — find matching regions</option>
              <option value="diamond" disabled={!engines.includes("diamond")}>
                DIAMOND — fast for large datasets{engines.includes("diamond") ? "" : " (unavailable on this server)"}
              </option>
            </select>
          </label>
          <p className="field-hint">{methodHint}</p>

          <div className="upload-thresholds">
            <SliderField label="Identity cutoff" value={identityCutoff} min={0} max={1} step={0.05} onChange={setIdentityCutoff} />
            <p className="field-hint">Links below this aren't kept, and genes are grouped into similarity groups at this threshold.</p>
            {engine === "diamond" && (
              <label className="field-inline">
                <span>Max E-value</span>
                <select value={String(evalueCutoff)} onChange={(e) => setEvalueCutoff(Number(e.target.value))}>
                  {[1e-1, 1e-2, 1e-3, 1e-5, 1e-10].map((v) => <option key={v} value={String(v)}>{v.toExponential(0)}</option>)}
                </select>
              </label>
            )}
          </div>

          {/* 3 — Run */}
          <button
            className="btn btn-primary btn-block"
            onClick={runStaged}
            disabled={loading || staged.length === 0}
          >
            {runLabel}
          </button>
          {/* With no figure the welcome card shows the failure; once one is up it's hidden. */}
          {data && jobError && !loading && (
            <p className="panel-alert" role="alert">{jobError}</p>
          )}
          {data && !staged.length && (
            <p className="field-hint upload-note">Showing a {data.clusters.length}-sequence figure · {data.links.length} links. Add files to run a new one.</p>
          )}
        </div>
      </Section>

      <Section key={data ? "layout-loaded" : "layout-empty"} title="Sequences" defaultOpen={!!data}>
        {data ? (
          <>
            <Subsection title="Sequence list" defaultOpen>
              <p className="muted">Untick a sequence to hide it from the figure and exports; its alignment is kept. Click the ring icon to mark a sequence circular, then shift its origin one CDS at a time with ‹ › (this doesn't draw a circular plot). Click ↕ to manually adjust space above a sequence's row</p>
              <p className="field-hint">
                Showing {shownCount} of {data.clusters.length} sequences{circularCount > 0 && ` · ${circularCount} circular`}
              </p>
              <div className="btn-row">
                <button className="btn" onClick={() => setAllClustersCircular(true)} disabled={circularCount === data.clusters.length}>Mark all circular</button>
                <button className="btn" onClick={() => setAllClustersCircular(false)} disabled={circularCount === 0}>Mark all linear</button>
              </div>
              {data.clusters.length > 8 && (
                <label className="field sequence-search">
                  <span>Find a sequence</span>
                  <input type="search" value={sequenceFilter} placeholder="Type a name…" onChange={(e) => setSequenceFilter(e.target.value)} />
                </label>
              )}
              <div className="circular-list">
                {filteredClusters.map((c) => {
                  const shown = !hiddenClusters[c.uid];
                  const last = shown && shownCount === 1;
                  const on = !!circularClusters[c.uid];
                  const rotation = clusterRotation[c.uid] ?? 0;
                  const space = clusterSpaceAbove[c.uid] ?? 0;
                  const spaceOpen = shown && spacingOpen === c.uid;
                  return (
                    <Fragment key={c.uid}>
                    <div className={"circular-row seq-row" + (shown ? "" : " is-hidden")}>
                      <label className="circular-toggle" title={last ? "At least one sequence must stay visible" : `${shown ? "Hide" : "Show"} ${c.name}`}>
                        <input type="checkbox" checked={shown} disabled={last} onChange={() => toggleClusterHidden(c.uid)} />
                        <span className="circular-name">{c.name}</span>
                      </label>
                      {on && (
                        <span className="rotate-steppers" aria-label={`Origin rotation for ${c.name}`}>
                          <button className="rotate-btn" title="Shift origin back by one CDS" aria-label="Shift origin back by one CDS" onClick={() => rotateCluster(c.uid, -1)}>‹</button>
                          <span className="rotate-count" title="Origin shift, in CDS">{rotation > 0 ? `+${rotation}` : rotation}</span>
                          <button className="rotate-btn" title="Shift origin forward by one CDS" aria-label="Shift origin forward by one CDS" onClick={() => rotateCluster(c.uid, 1)}>›</button>
                          {/* Reserve the reset slot even at 0 so the steppers don't shift sideways. */}
                          <button
                            className="rotate-reset"
                            title="Restore this sequence's original origin"
                            aria-label="Restore original origin"
                            disabled={rotation === 0}
                            onClick={() => rotateCluster(c.uid, -rotation)}
                          >
                            <ResetIcon />
                          </button>
                        </span>
                      )}
                      <button
                        className={"seq-circ" + (space > 0 ? " active" : "")}
                        aria-expanded={spaceOpen}
                        aria-label={`Space above ${c.name}`}
                        title={space > 0 ? `${space} px of extra space above this row — click to adjust` : "Add space above this sequence's row"}
                        disabled={!shown}
                        onClick={() => setSpacingOpen(spaceOpen ? null : c.uid)}
                      >
                        <SpaceIcon />
                      </button>
                      <button
                        className={"seq-circ" + (on ? " active" : "")}
                        aria-pressed={on}
                        aria-label={`Circular sequence: ${c.name}`}
                        title={on ? "Circular — click to treat as linear" : "Linear — click to treat as circular (lets you shift the origin)"}
                        onClick={() => toggleClusterCircular(c.uid)}
                      >
                        <CircularIcon />
                      </button>
                    </div>
                    {spaceOpen && (
                      <div className="seq-space">
                        <SliderField label="Space above (px)" value={space} min={0} max={400} step={5} onChange={(v) => setClusterSpaceAbove(c.uid, v)} />
                      </div>
                    )}
                    </Fragment>
                  );
                })}
                {!filteredClusters.length && <p className="muted">No sequence names match this search.</p>}
              </div>
              <div className="btn-row">
                <button className="btn" onClick={showAllClusters} disabled={hiddenCount === 0}>Show all</button>
                <button className="btn" onClick={resetAllClusterRotations} disabled={!hasRotations}>Reset all origins</button>
                <button className="btn" onClick={resetAllClusterSpaceAbove} disabled={!hasSpaceAbove}>Reset all spacing</button>
              </div>
            </Subsection>

            <Subsection title="Layout">
              <p className="muted">Drag a sequence's ⠿ handle sideways to reposition it, or vertically to move it into another row. Use ⇄ on the canvas to reverse its direction.</p>
              <SliderField label="Scale (px/kb)" value={style.pxPerKb} min={5} max={500} step={5} onChange={(v) => setStyle({ pxPerKb: v })} />
              <SliderField label="Row spacing" value={style.clusterSpacing} min={10} max={200} onChange={(v) => setStyle({ clusterSpacing: v })} />
              <CheckField label="Prevent sequence overlap" checked={style.preventOverlap} onChange={(v) => setStyle({ preventOverlap: v })} />
              <button className="btn btn-block" onClick={clearClusterOffsets} disabled={!hasOffsets}>Reset sequence positions</button>
            </Subsection>
          </>
        ) : <p className="muted">Load data to choose, arrange and rotate sequences.</p>}
      </Section>

      <Section key={data ? "links-loaded" : "links-empty"} title="Similarity links" defaultOpen={!!data}>
        <Subsection title="Filtering" defaultOpen>
          <p className="scope-note">These controls update the currently displayed links immediately.</p>
          <label className="field">
            <span>Metric</span>
            <select value={activeMetric} onChange={(e) => onMetricChange(e.target.value as MetricKey)}>
              {metricChoices.map((m) => <option key={m} value={m}>{METRIC_OPTION_LABEL[m]}</option>)}
            </select>
          </label>
          <p className="muted">{METRIC_INFO[activeMetric]}</p>
          <SliderField
            label={mr.lower ? "Hide links above" : "Hide links below"}
            value={threshold}
            min={mr.lo}
            max={mr.hi}
            step={mr.step}
            onChange={(v) => setStyle({ linkThreshold: v })}
          />
          <p className="muted">Filters the displayed links only. Similarity groups (and their colours) come from the identity cutoff used for the alignment.</p>
          {spanned && (
            <>
              <SliderField label="Minimum matching region (aa)" value={minFragment} min={0} max={fragMax} step={1} onChange={(v) => setStyle({ minFragmentAa: v })} />
              <p className="muted">Hides local-alignment links whose matching region is shorter than this length.</p>
            </>
          )}
        </Subsection>
        <Subsection title="Appearance">
          <CheckField label="Show links" checked={style.showLinks} onChange={(v) => setStyle({ showLinks: v })} />
          <CheckField label="Use gene colours" checked={style.colourLinks} disabled={!style.showLinks} onChange={(v) => setStyle({ colourLinks: v })} />
          <CheckField label="Draw straight links" checked={style.straightLinks} disabled={!style.showLinks} onChange={(v) => setStyle({ straightLinks: v })} />
          <CheckField label={`Show ${METRIC_LABEL[activeMetric]} values`} checked={style.showLinkLabels} disabled={!style.showLinks} onChange={(v) => setStyle({ showLinkLabels: v })} />
          <CheckField label="Use aligned region only" checked={style.anchorLinksToAligned} disabled={!style.showLinks} onChange={(v) => setStyle({ anchorLinksToAligned: v })} />
          <SliderField label="Opacity" value={style.linkOpacity} min={0} max={1} step={0.05} disabled={!style.showLinks} onChange={(v) => setStyle({ linkOpacity: v })} />
          <p className="muted">“Use aligned region only” narrows local-alignment ribbons to the part of each gene that actually matched.</p>
        </Subsection>
      </Section>

      <Section key={data ? "colour-data" : "colour-empty"} title="Colours & legend" defaultOpen={!!data}>
        {data ? (
          <>
            <Subsection title="Colour mapping" defaultOpen>
              <p className="muted">Choose what gene colours represent, then select a palette or edit individual colours.</p>
            {/* Stacked, not inline: four segments don't fit beside a label at panel
                width. A div, not a <label>, so clicking the caption doesn't press
                the first segment. */}
            <div className="field" role="group" aria-label="Colour by">
              <span>Colour by</span>
              <div className="segmented segmented-fill">
                {(["group", "cluster", "field", "custom"] as ColourBy[]).map((c) => (
                  <button key={c} className={"seg" + (colourBy === c ? " active" : "")} onClick={() => onColourByChange(c)}>
                    {COLOUR_BY_LABEL[c]}
                  </button>
                ))}
              </div>
            </div>

            {colourBy === "field" && (
              <label className="field">
                <span>GenBank field</span>
                <select value={colourField} onChange={(e) => setColourField(e.target.value)}>
                  {!fields.length && <option value="">No fields in data</option>}
                  {fields.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </label>
            )}

            {colourBy === "custom" ? (
              <CustomColourEditor />
            ) : (
              <>
                <label className="field">
                  <span>Palette</span>
                  <select value={paletteName} onChange={(e) => setPaletteName(e.target.value)}>
                    {PALETTE_NAMES.map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <div className="legend">
                  {items.map((item) => (
                    <div className="legend-row" key={item.id}>
                      <ColourSwatch value={item.colour} title="Override colour" onChange={(v) => setOverride(item.id, v)} />
                      {/* Similarity-group names are editable; cluster names are
                          renamed on the figure and field values come from the data. */}
                      {colourBy === "group" && item.id !== OTHER_ID ? (
                        <input
                          className="custom-group-name"
                          value={item.label}
                          title="Rename group"
                          onChange={(e) => renameGroup(item.id, e.target.value)}
                        />
                      ) : (
                        <span className="legend-label">{item.label}</span>
                      )}
                      <span className="legend-count">{item.count}</span>
                    </div>
                  ))}
                  {!items.length && (
                    <p className="muted">
                      {colourBy === "field"
                        ? "No genes have a value for this field."
                        : "Nothing to colour yet."}
                    </p>
                  )}
                </div>
              </>
            )}
            {colourBy !== "custom" && (
              <>
                <div className="flat-divider" />
                <p className="export-group-label">Save &amp; load colours</p>
                <p className="muted">Save the current label-to-colour mapping for reuse, or load a <code>label,colour</code> CSV to apply matching colours.</p>
                <div className="btn-row">
                  <button className="btn" onClick={exportColourCSV}>Save CSV</button>
                  <label className="btn">Load CSV<input type="file" accept=".csv" hidden onChange={importColourCSV} /></label>
                </div>
                <button className="btn btn-block" onClick={clearOverrides} disabled={!Object.keys(overrides).length}>Reset edited colours</button>
              </>
            )}
            </Subsection>
            <Subsection title="Legend">
              <CheckField label="Show colour legend" checked={style.showLegend} onChange={(v) => setStyle({ showLegend: v })} />
              <SliderField label="Maximum entries (0 = all)" value={style.maxLegendEntries} min={0} max={40} disabled={!style.showLegend} onChange={(v) => setStyle({ maxLegendEntries: v })} />
              <SliderField label="Text size" value={style.legendFontSize} min={6} max={32} disabled={!style.showLegend} onChange={(v) => setStyle({ legendFontSize: v })} />
              <SliderField label="Entry spacing" value={style.legendSpacing} min={4} max={60} disabled={!style.showLegend} onChange={(v) => setStyle({ legendSpacing: v })} />
              <p className="muted">The legend reflects the active colour mapping. Extra entries are combined into “Other” when a maximum is set.</p>
            </Subsection>
          </>
        ) : (
          <p className="muted">Genes are coloured by similarity group once data loads.</p>
        )}
      </Section>

      <Section title="Figure style">
        <Subsection title="Genes & backbone" defaultOpen>
          <SelectField label="Shape" value={style.geneShape} options={GENE_SHAPES} onChange={(v) => setStyle({ geneShape: v })} />
          <SliderField label="Gene height" value={style.trackHeight} min={4} max={48} onChange={(v) => setStyle({ trackHeight: v })} />
          <SliderField label="Arrow-tip length" value={style.tipLength} min={0} max={48} onChange={(v) => setStyle({ tipLength: v })} />
          <SliderField label="Outline width" value={style.geneStrokeWidth} min={0} max={4} step={0.1} onChange={(v) => setStyle({ geneStrokeWidth: v })} />
          <ColourField label="Outline colour" value={style.geneStroke} onChange={(v) => setStyle({ geneStroke: v })} />
          <div className="flat-divider" />
          <ColourField label="Backbone colour" value={style.backboneColour} onChange={(v) => setStyle({ backboneColour: v })} />
          <SliderField label="Backbone width" value={style.backboneWidth} min={0} max={8} step={0.5} onChange={(v) => setStyle({ backboneWidth: v })} />
          <SliderField label="Backbone opacity" value={style.backboneOpacity} min={0} max={1} step={0.05} onChange={(v) => setStyle({ backboneOpacity: v })} />
          <p className="muted">The backbone marks the sequence extent behind its genes.</p>
        </Subsection>
        <Subsection title="Sequence names">
          <CheckField label="Show sequence names" checked={style.showClusterNames} onChange={(v) => setStyle({ showClusterNames: v })} />
          <SliderField label="Text size" value={style.clusterFontSize} min={6} max={28} disabled={!style.showClusterNames} onChange={(v) => setStyle({ clusterFontSize: v })} />
          <SelectField label="Position" value={style.clusterLabelPlacement} disabled={!style.showClusterNames} options={[{ value: "above", label: "Above sequence" }, { value: "beside", label: "Beside sequence" }]} onChange={(v) => setStyle({ clusterLabelPlacement: v })} />
          <SelectField label="Side" value={style.clusterLabelSide} disabled={!style.showClusterNames} options={[{ value: "left", label: "Left" }, { value: "right", label: "Right" }]} onChange={(v) => setStyle({ clusterLabelSide: v })} />
          <CheckField
            label="Pin names to canvas edge"
            checked={style.clusterLabelPinned || style.clusterLabelPlacement === "beside"}
            disabled={!style.showClusterNames || style.clusterLabelPlacement === "beside"}
            onChange={(v) => setStyle({ clusterLabelPinned: v })}
          />
          <p className="muted">Pinned names remain at the chosen canvas edge while you pan. Names placed beside a sequence are always pinned.</p>
        </Subsection>
        <Subsection title="Gene labels & tooltip">
          <SelectField label="Show labels" value={style.showGeneLabels} options={[{ value: "auto", label: "Auto (when zoomed in)" }, { value: "always", label: "Always" }, { value: "never", label: "Never" }]} onChange={(v) => setStyle({ showGeneLabels: v })} />
          <SelectField label="Label field" value={style.geneLabelField} disabled={style.showGeneLabels === "never"} options={[{ value: "", label: "Auto (gene → locus tag → protein ID)" }, { value: CUSTOM_GROUP_LABEL_FIELD, label: "Custom group name" }, ...fields.map((f) => ({ value: f, label: f }))]} onChange={(v) => setStyle({ geneLabelField: v })} />
          <SelectField label="Scope" value={style.geneLabelScope} disabled={style.showGeneLabels === "never"} options={[{ value: "all", label: "All genes" }, { value: "custom", label: "Custom groups only" }]} onChange={(v) => setStyle({ geneLabelScope: v })} />
          <SelectField label="Position" value={style.geneLabelPosition} disabled={style.showGeneLabels === "never"} options={[{ value: "above", label: "Above the gene" }, { value: "on", label: "On the gene" }]} onChange={(v) => setStyle({ geneLabelPosition: v })} />
          <SelectField label="Rotation" value={String(style.geneLabelRotation)} disabled={style.showGeneLabels === "never"} options={[{ value: "0", label: "Horizontal" }, { value: "45", label: "Diagonal (45°)" }, { value: "90", label: "Vertical (90°)" }]} onChange={(v) => setStyle({ geneLabelRotation: Number(v) })} />
          <SliderField label="Text size" value={style.geneLabelFontSize} min={6} max={20} disabled={style.showGeneLabels === "never"} onChange={(v) => setStyle({ geneLabelFontSize: v })} />
          <p className="muted">Auto labels appear as you zoom in. Overlapping labels are omitted to keep the figure readable.</p>
          <div className="flat-divider" />
          <SliderField label="Tooltip annotations (0 = all)" value={style.maxTooltipFields} min={0} max={24} onChange={(v) => setStyle({ maxTooltipFields: v })} />
          <p className="muted">Annotations shown when hovering a gene, functional fields first (product, function, PFAM, ECOD…). Click a gene to open the full record regardless of this limit.</p>
        </Subsection>
        <Subsection title="Scale bar & background">
          <CheckField label="Show scale bar" checked={style.showScaleBar} onChange={(v) => setStyle({ showScaleBar: v })} />
          <SliderField label="Length (kb, 0 = automatic)" value={style.scaleBarKb} min={0} max={50} step={0.5} disabled={!style.showScaleBar} onChange={(v) => setStyle({ scaleBarKb: v })} />
          <SliderField label="Bar thickness" value={style.scaleBarThickness} min={0.5} max={8} step={0.5} disabled={!style.showScaleBar} onChange={(v) => setStyle({ scaleBarThickness: v })} />
          <SliderField label="Scale text size" value={style.scaleFontSize} min={6} max={32} disabled={!style.showScaleBar} onChange={(v) => setStyle({ scaleFontSize: v })} />
          <ColourField label="Background" value={style.background} onChange={(v) => setStyle({ background: v })} />
        </Subsection>
        <button className="btn btn-block" onClick={resetStyle} title="Restore every style setting, including link, legend and layout styling, to its default">Reset all style settings</button>
      </Section>

    </aside>
  );
}
