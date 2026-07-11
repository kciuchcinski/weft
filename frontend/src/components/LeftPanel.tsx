import { useEffect, useState, type ReactNode } from "react";
import { useStore } from "../state/store";
import { fetchCapabilities, loadExampleSession, runUploadJob } from "../api";
import { availableFields, computeColours, PALETTE_NAMES, type ColourBy } from "../render/palette";
import {
  availableMetrics,
  geneAaLengths,
  hasPartialSpans,
  linkFragmentAa,
  metricLowerIsBetter,
  type GeneShapeKind,
} from "../render/layout";
import { exportAlignmentTableCSV, exportPNG, exportSimilarityMatrixCSV, exportSVG } from "../export";
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

const INPUT_RE = /\.(gbk|gb|genbank|gbf|gbff|gff|gff3|gtf|fa|fna|fasta|fas|faa)$/i;

function Section({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className={"section" + (open ? " open" : "")}>
      <button className="section-header" onClick={() => setOpen((o) => !o)}>
        <span className="chevron">{open ? "▾" : "▸"}</span>
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
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className={"subsection" + (open ? " open" : "")}>
      <button className="subsection-header" onClick={() => setOpen((o) => !o)}>
        <span>{title}</span>
        <span className="subsection-chevron">{open ? "−" : "+"}</span>
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

function ColourField(p: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field-inline">
      <span>{p.label}</span>
      <input type="color" className="swatch-input" value={p.value} onChange={(e) => p.onChange(e.target.value)} />
    </label>
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
            <input
              type="color"
              className="swatch-input"
              value={g.colour}
              title="Group colour"
              onChange={(e) => setCustomGroupColour(g.id, e.target.value)}
            />
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

export default function LeftPanel() {
  const data = useStore((s) => s.data);
  const setData = useStore((s) => s.setData);
  const loadSession = useStore((s) => s.loadSession);
  const setJobStatus = useStore((s) => s.setJobStatus);
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

  const [loading, setLoading] = useState(false);
  const [drag, setDrag] = useState(false);
  const [sequenceFilter, setSequenceFilter] = useState("");
  // Engines this deployment can run. The hosted beta ships parasail only; DIAMOND
  // appears only where the binary is present (local dev / a conda-based image).
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
  const items = data ? computeColours(data, colourBy, paletteName, overrides, colourField, customGroups, style.maxLegendEntries).items : [];
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
  const visibleClusters = data?.clusters.filter((c) => c.name.toLowerCase().includes(sequenceFilter.trim().toLowerCase())) ?? [];
  const circularCount = data?.clusters.filter((c) => circularClusters[c.uid]).length ?? 0;
  const hasRotations = Object.values(clusterRotation).some((v) => v !== 0);

  const loadExample = async () => {
    setLoading(true);
    try {
      loadSession(await loadExampleSession(setJobStatus));
      setJobStatus("idle");
    } catch (e) {
      setJobStatus("failed");
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const onFiles = async (fileList: FileList | null) => {
    if (!fileList) return;
    const files = [...fileList].filter((f) => INPUT_RE.test(f.name));
    if (!files.length) {
      setJobStatus("no supported files");
      return;
    }
    setLoading(true);
    try {
      setData(await runUploadJob(files, setJobStatus, { engine, mode, identity_cutoff: identityCutoff, evalue_cutoff: evalueCutoff }));
    } catch (e) {
      setJobStatus("failed");
      console.error(e);
    } finally {
      setLoading(false);
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

  return (
    <aside className="left-panel">
      <Section key={data ? "data-loaded" : "data-empty"} title="Data & alignment" defaultOpen={!data}>
        <Subsection title="Input" defaultOpen>
          {data ? (
            <p className="muted">{data.clusters.length} sequences · {geneCount} genes · {data.links.length} similarity links loaded.</p>
          ) : (
            <p className="muted">Add GenBank or GFF3/GTF+FASTA files, or start with the bundled example.</p>
          )}
          <label
            className={"dropzone" + (drag ? " drag" : "")}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); onFiles(e.dataTransfer.files); }}
          >
            {loading ? "Running…" : "Drop input files here, or click to choose"}
            <input type="file" accept=".gbk,.gb,.genbank,.gbf,.gbff,.gff,.gff3,.gtf,.fa,.fna,.fasta,.fas,.faa" multiple hidden onChange={(e) => onFiles(e.target.files)} />
          </label>
          <label className="field">
            <span>Upload a folder</span>
            <input
              type="file"
              multiple
              // @ts-expect-error non-standard attribute supported by Chromium-based browsers
              webkitdirectory=""
              onChange={(e) => onFiles(e.target.files)}
            />
          </label>
          <button className="btn btn-block" onClick={loadExample} disabled={loading}>{loading ? "Loading…" : "Load example dataset"}</button>
          <p className="muted privacy-note">Files are processed on the server and deleted shortly after the job runs. This is a beta, so avoid sensitive unpublished data.</p>
        </Subsection>

        <Subsection title="Alignment for new uploads" defaultOpen={!data}>
          <p className="scope-note">These settings apply when you upload new files. They do not recompute the figure already on screen.</p>
          <label className="field">
            <span>Method</span>
            <select
              value={engine === "parasail" ? `parasail-${mode}` : "diamond"}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "diamond") setEngine("diamond");
                else {
                  setEngine("parasail");
                  setMode(v === "parasail-local" ? "local" : "global");
                }
              }}
            >
              <option value="parasail-global">Global — compare whole proteins</option>
              <option value="parasail-local">Local — find matching regions</option>
              {engines.includes("diamond") && <option value="diamond">DIAMOND — fast for large datasets</option>}
            </select>
          </label>
          <SliderField label="Minimum identity" value={identityCutoff} min={0} max={1} step={0.05} onChange={setIdentityCutoff} />
          {engine === "diamond" && (
            <label className="field">
              <span>Maximum E-value</span>
              <select value={String(evalueCutoff)} onChange={(e) => setEvalueCutoff(Number(e.target.value))}>
                {[1e-1, 1e-2, 1e-3, 1e-5, 1e-10].map((v) => <option key={v} value={String(v)}>{v.toExponential(0)}</option>)}
              </select>
            </label>
          )}
          <p className="muted">
            {engine === "parasail"
              ? mode === "local"
                ? "Local alignment finds shared regions such as individual domains. It is exact, but best suited to smaller datasets."
                : "Global alignment compares each protein across its full length. It is exact, but slower than DIAMOND."
              : "DIAMOND performs a fast all-vs-all protein search and is recommended for large datasets."}
          </p>
        </Subsection>
      </Section>

      <Section key={data ? "links-loaded" : "links-empty"} title="Similarity links" defaultOpen={!!data}>
        <Subsection title="Metric & filtering" defaultOpen>
          <p className="scope-note">These controls update the currently displayed links immediately.</p>
          <label className="field">
            <span>Metric</span>
            <select value={activeMetric} onChange={(e) => onMetricChange(e.target.value as MetricKey)}>
              {metricChoices.map((m) => <option key={m} value={m}>{METRIC_OPTION_LABEL[m]}</option>)}
            </select>
          </label>
          <p className="muted">{METRIC_INFO[activeMetric]}</p>
          <SliderField
            label={mr.lower ? `Maximum ${METRIC_LABEL[activeMetric]}` : `Minimum ${METRIC_LABEL[activeMetric]}`}
            value={threshold}
            min={mr.lo}
            max={mr.hi}
            step={mr.step}
            onChange={(v) => setStyle({ linkThreshold: v })}
          />
          <p className="muted">{mr.lower ? "Links above this value are hidden." : "Links below this value are hidden."}</p>
          {spanned && (
            <>
              <SliderField label="Minimum matching region (aa)" value={minFragment} min={0} max={fragMax} step={1} onChange={(v) => setStyle({ minFragmentAa: v })} />
              <p className="muted">Hides local-alignment links whose matching region is shorter than this length.</p>
            </>
          )}
        </Subsection>
        <Subsection title="Link appearance">
          <CheckField label="Show links" checked={style.showLinks} onChange={(v) => setStyle({ showLinks: v })} />
          <CheckField label="Use gene colours" checked={style.colourLinks} disabled={!style.showLinks} onChange={(v) => setStyle({ colourLinks: v })} />
          <CheckField label="Draw straight links" checked={style.straightLinks} disabled={!style.showLinks} onChange={(v) => setStyle({ straightLinks: v })} />
          <CheckField label={`Show ${METRIC_LABEL[activeMetric]} values`} checked={style.showLinkLabels} disabled={!style.showLinks} onChange={(v) => setStyle({ showLinkLabels: v })} />
          <CheckField label="Use aligned region only" checked={style.anchorLinksToAligned} disabled={!style.showLinks} onChange={(v) => setStyle({ anchorLinksToAligned: v })} />
          <SliderField label="Opacity" value={style.linkOpacity} min={0} max={1} step={0.05} disabled={!style.showLinks} onChange={(v) => setStyle({ linkOpacity: v })} />
          <p className="muted">“Use aligned region only” narrows local-alignment ribbons to the part of each gene that actually matched.</p>
        </Subsection>
      </Section>

      <Section key={data ? "layout-loaded" : "layout-empty"} title="Sequences & layout" defaultOpen={!!data}>
        {data ? (
          <>
            <Subsection title="Row arrangement" defaultOpen>
              <p className="muted">Drag a sequence's ⠿ handle sideways to reposition it, or vertically to move it into another row. Use ⇄ on the canvas to reverse its direction.</p>
              <SliderField label="Scale (px/kb)" value={style.pxPerKb} min={5} max={500} step={5} onChange={(v) => setStyle({ pxPerKb: v })} />
              <SliderField label="Row spacing" value={style.clusterSpacing} min={10} max={200} onChange={(v) => setStyle({ clusterSpacing: v })} />
              <CheckField label="Prevent sequence overlap" checked={style.preventOverlap} onChange={(v) => setStyle({ preventOverlap: v })} />
              <button className="btn btn-block" onClick={clearClusterOffsets} disabled={!hasOffsets}>Reset sequence positions</button>
            </Subsection>

            <Subsection title="Circular sequences" defaultOpen={circularCount > 0}>
              <p className="muted">Mark biologically circular sequences, then shift their displayed origin one CDS at a time to align them with related sequences. This does not turn the figure into a circular plot.</p>
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
                {visibleClusters.map((c) => {
                  const on = !!circularClusters[c.uid];
                  const rotation = clusterRotation[c.uid] ?? 0;
                  return (
                    <div className="circular-row" key={c.uid}>
                      <label className="circular-toggle" title={on ? "Treat as a linear sequence" : "Treat as a circular sequence"}>
                        <input type="checkbox" checked={on} onChange={() => toggleClusterCircular(c.uid)} />
                        <span className="circular-name">{c.name}</span>
                      </label>
                      {on && (
                        <span className="rotate-steppers" aria-label={`Origin rotation for ${c.name}`}>
                          <button className="rotate-btn" title="Shift origin back by one CDS" onClick={() => rotateCluster(c.uid, -1)}>−1</button>
                          <span className="rotate-count" title="Current rotation">{rotation > 0 ? `+${rotation}` : rotation}</span>
                          <button className="rotate-btn" title="Shift origin forward by one CDS" onClick={() => rotateCluster(c.uid, 1)}>+1</button>
                          <button className="rotate-reset" title="Restore this sequence's original origin" disabled={rotation === 0} onClick={() => rotateCluster(c.uid, -rotation)}>Reset</button>
                        </span>
                      )}
                    </div>
                  );
                })}
                {!visibleClusters.length && <p className="muted">No sequence names match this search.</p>}
              </div>
              <button className="btn btn-block" onClick={resetAllClusterRotations} disabled={!hasRotations}>Reset all sequence origins</button>
            </Subsection>
          </>
        ) : <p className="muted">Load data to arrange sequences and configure circular origins.</p>}
      </Section>

      <Section key={data ? "colour-data" : "colour-empty"} title="Colours & legend" defaultOpen={!!data}>
        {data ? (
          <>
            <Subsection title="Colour mapping" defaultOpen>
              <p className="muted">Choose what gene colours represent, then select a palette or edit individual colours.</p>
            <label className="field-inline">
              <span>Colour by</span>
              <div className="segmented">
                {(["group", "cluster", "field", "custom"] as ColourBy[]).map((c) => (
                  <button key={c} className={"seg" + (colourBy === c ? " active" : "")} onClick={() => onColourByChange(c)}>
                    {c}
                  </button>
                ))}
              </div>
            </label>

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
                      <input
                        type="color"
                        className="swatch-input"
                        value={item.colour}
                        title="Override colour"
                        onChange={(e) => setOverride(item.id, e.target.value)}
                      />
                      <span className="legend-label">{item.label}</span>
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
            </Subsection>
            {colourBy !== "custom" && (
              <Subsection title="Colour map">
                <p className="muted">Save the current label-to-colour mapping for reuse, or import a <code>label,colour</code> CSV to apply matching overrides.</p>
                <div className="btn-row">
                  <button className="btn" onClick={exportColourCSV}>Export CSV</button>
                  <label className="btn">Import CSV<input type="file" accept=".csv" hidden onChange={importColourCSV} /></label>
                </div>
                <button className="btn btn-block" onClick={clearOverrides}>Reset colour overrides</button>
              </Subsection>
            )}
            <Subsection title="Figure legend">
              <CheckField label="Show colour legend" checked={style.showLegend} onChange={(v) => setStyle({ showLegend: v })} />
              <SliderField label="Maximum entries (0 = all)" value={style.maxLegendEntries} min={0} max={20} disabled={!style.showLegend} onChange={(v) => setStyle({ maxLegendEntries: v })} />
              <SliderField label="Text size" value={style.legendFontSize} min={6} max={32} disabled={!style.showLegend} onChange={(v) => setStyle({ legendFontSize: v })} />
              <SliderField label="Entry spacing" value={style.legendSpacing} min={4} max={60} disabled={!style.showLegend} onChange={(v) => setStyle({ legendSpacing: v })} />
              <p className="muted">The legend reflects the active colour mapping. Extra entries are combined into “Other” when a maximum is set.</p>
            </Subsection>
          </>
        ) : (
          <p className="muted">Genes are coloured by homology group once data loads.</p>
        )}
      </Section>

      <Section title="Figure appearance">
        <Subsection title="Genes" defaultOpen>
          <SelectField label="Shape" value={style.geneShape} options={GENE_SHAPES} onChange={(v) => setStyle({ geneShape: v })} />
          <SliderField label="Gene height" value={style.trackHeight} min={4} max={48} onChange={(v) => setStyle({ trackHeight: v })} />
          <SliderField label="Arrow-tip length" value={style.tipLength} min={0} max={48} onChange={(v) => setStyle({ tipLength: v })} />
          <SliderField label="Outline width" value={style.geneStrokeWidth} min={0} max={4} step={0.1} onChange={(v) => setStyle({ geneStrokeWidth: v })} />
          <ColourField label="Outline colour" value={style.geneStroke} onChange={(v) => setStyle({ geneStroke: v })} />
        </Subsection>
        <Subsection title="Sequence backbone">
          <ColourField label="Colour" value={style.backboneColour} onChange={(v) => setStyle({ backboneColour: v })} />
          <SliderField label="Width" value={style.backboneWidth} min={0} max={8} step={0.5} onChange={(v) => setStyle({ backboneWidth: v })} />
          <SliderField label="Opacity" value={style.backboneOpacity} min={0} max={1} step={0.05} onChange={(v) => setStyle({ backboneOpacity: v })} />
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
        <Subsection title="Gene labels">
          <SelectField label="Show labels" value={style.showGeneLabels} options={[{ value: "auto", label: "Auto (when zoomed in)" }, { value: "always", label: "Always" }, { value: "never", label: "Never" }]} onChange={(v) => setStyle({ showGeneLabels: v })} />
          <SelectField label="Label field" value={style.geneLabelField} disabled={style.showGeneLabels === "never"} options={[{ value: "", label: "Auto (gene → locus tag → protein ID)" }, ...fields.map((f) => ({ value: f, label: f }))]} onChange={(v) => setStyle({ geneLabelField: v })} />
          <SelectField label="Scope" value={style.geneLabelScope} disabled={style.showGeneLabels === "never"} options={[{ value: "all", label: "All genes" }, { value: "custom", label: "Custom groups only" }]} onChange={(v) => setStyle({ geneLabelScope: v })} />
          <SelectField label="Position" value={style.geneLabelPosition} disabled={style.showGeneLabels === "never"} options={[{ value: "above", label: "Above the gene" }, { value: "on", label: "On the gene" }]} onChange={(v) => setStyle({ geneLabelPosition: v })} />
          <SelectField label="Rotation" value={String(style.geneLabelRotation)} disabled={style.showGeneLabels === "never"} options={[{ value: "0", label: "Horizontal" }, { value: "45", label: "Diagonal (45°)" }, { value: "90", label: "Vertical (90°)" }]} onChange={(v) => setStyle({ geneLabelRotation: Number(v) })} />
          <SliderField label="Text size" value={style.geneLabelFontSize} min={6} max={20} disabled={style.showGeneLabels === "never"} onChange={(v) => setStyle({ geneLabelFontSize: v })} />
          <p className="muted">Auto labels appear as you zoom in. Overlapping labels are omitted to keep the figure readable.</p>
        </Subsection>
        <Subsection title="Scale bar & canvas">
          <CheckField label="Show scale bar" checked={style.showScaleBar} onChange={(v) => setStyle({ showScaleBar: v })} />
          <SliderField label="Length (kb, 0 = automatic)" value={style.scaleBarKb} min={0} max={50} step={0.5} disabled={!style.showScaleBar} onChange={(v) => setStyle({ scaleBarKb: v })} />
          <SliderField label="Bar thickness" value={style.scaleBarThickness} min={0.5} max={8} step={0.5} disabled={!style.showScaleBar} onChange={(v) => setStyle({ scaleBarThickness: v })} />
          <SliderField label="Scale text size" value={style.scaleFontSize} min={6} max={32} disabled={!style.showScaleBar} onChange={(v) => setStyle({ scaleFontSize: v })} />
          <ColourField label="Background" value={style.background} onChange={(v) => setStyle({ background: v })} />
          <button className="btn btn-block" onClick={resetStyle}>Reset all appearance settings</button>
        </Subsection>
      </Section>

      <Section title="Export">
        <p className="muted">Export the finished figure for publication, or download the underlying similarity results for further analysis.</p>
        <p className="export-group-label">Figure</p>
        <div className="btn-row">
          <button className="btn" onClick={() => exportSVG(useStore.getState())} disabled={!data}>Export SVG</button>
          <button className="btn" onClick={() => exportPNG(useStore.getState())} disabled={!data}>Export PNG</button>
        </div>
        <p className="export-group-label">Similarity data</p>
        <div className="btn-row">
          <button className="btn" onClick={() => exportAlignmentTableCSV(useStore.getState())} disabled={!data}>
            Alignment CSV
          </button>
          <button className="btn" onClick={() => exportSimilarityMatrixCSV(useStore.getState())} disabled={!data}>
            Matrix CSV
          </button>
        </div>
      </Section>
    </aside>
  );
}
