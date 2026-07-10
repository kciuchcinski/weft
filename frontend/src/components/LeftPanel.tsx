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
  onChange: (v: T) => void;
}) {
  return (
    <label className="field-inline">
      <span>{p.label}</span>
      <select value={p.value} onChange={(e) => p.onChange(e.target.value as T)}>
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

function CheckField(p: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="field-inline">
      <span>{p.label}</span>
      <input type="checkbox" checked={p.checked} onChange={(e) => p.onChange(e.target.checked)} />
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

  const [loading, setLoading] = useState(false);
  const [drag, setDrag] = useState(false);
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
      <Section title="Input & data" defaultOpen>
        {data ? (
          <p className="muted">
            {data.clusters.length} clusters · {geneCount} genes · {data.links.length} links loaded.
          </p>
        ) : (
          <p className="muted">Add GenBank or GFF3/GTF+FASTA files, or run the bundled example.</p>
        )}
        <label
          className={"dropzone" + (drag ? " drag" : "")}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); onFiles(e.dataTransfer.files); }}
        >
          {loading ? "Running…" : "Drop input files here (GenBank or GFF3/GTF+FASTA), or click to choose"}
          <input
            type="file"
            accept=".gbk,.gb,.genbank,.gbf,.gbff,.gff,.gff3,.gtf,.fa,.fna,.fasta,.fas,.faa"
            multiple
            hidden
            onChange={(e) => onFiles(e.target.files)}
          />
        </label>
        <label className="field">
          <span>Folder upload</span>
          <input
            type="file"
            multiple
            // @ts-expect-error non-standard attribute supported by Chromium-based browsers
            webkitdirectory=""
            onChange={(e) => onFiles(e.target.files)}
          />
        </label>

        <p className="style-group">Alignment</p>
        <label className="field">
          <span>Engine</span>
          <select value={engine} onChange={(e) => setEngine(e.target.value)}>
            <option value="parasail">parasail (exact pairwise)</option>
            {engines.includes("diamond") && <option value="diamond">DIAMOND (fast)</option>}
          </select>
        </label>
        {engine === "parasail" && (
          <label className="field">
            <span>Mode</span>
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="global">Global (whole protein)</option>
              <option value="local">Local (partial regions)</option>
            </select>
          </label>
        )}
        <SliderField
          label="Min identity"
          value={identityCutoff}
          min={0}
          max={1}
          step={0.05}
          onChange={setIdentityCutoff}
        />
        {engine === "diamond" && (
          <label className="field">
            <span>Max E-value</span>
            <select value={String(evalueCutoff)} onChange={(e) => setEvalueCutoff(Number(e.target.value))}>
              {[1e-1, 1e-2, 1e-3, 1e-5, 1e-10].map((v) => (
                <option key={v} value={String(v)}>{v.toExponential(0)}</option>
              ))}
            </select>
          </label>
        )}
        <p className="muted">
          {engine === "parasail"
            ? mode === "local"
              ? "Smith–Waterman: links shared sub-regions, so a partial match (e.g. one shared domain) draws a ribbon over just that region. Exact but slower — best for smaller sets."
              : "Needleman–Wunsch: one identity/similarity per protein pair over the full length (clinker-style). Exact but slower than DIAMOND."
            : "DIAMOND all-vs-all blastp. Fast; recommended for large datasets."}{" "}
          These apply to the next upload; the bundled example is precomputed.
        </p>

        <button className="btn btn-block" onClick={loadExample} disabled={loading}>
          {loading ? "Loading…" : "Load example dataset"}
        </button>
        <p className="muted privacy-note">
          Uploaded files are processed on the server and automatically deleted a short while
          after your job runs. This is a beta — avoid uploading sensitive unpublished data.
        </p>
      </Section>

      <Section title="Links" defaultOpen={!!data}>
        <p className="style-group">Filter</p>
        <label className="field">
          <span>Active metric</span>
          <select value={activeMetric} onChange={(e) => onMetricChange(e.target.value as MetricKey)}>
            {metricChoices.map((m) => (
              <option key={m} value={m}>{METRIC_OPTION_LABEL[m]}</option>
            ))}
          </select>
        </label>
        <p className="muted">{METRIC_INFO[activeMetric]} Drives homology-link opacity live.</p>
        <SliderField
          label={mr.lower ? `Max ${METRIC_LABEL[activeMetric]}` : `Min ${METRIC_LABEL[activeMetric]}`}
          value={threshold}
          min={mr.lo}
          max={mr.hi}
          step={mr.step}
          onChange={(v) => setStyle({ linkThreshold: v })}
        />
        <p className="muted">
          {mr.lower
            ? `Hide links with an ${METRIC_LABEL[activeMetric]} above this cutoff.`
            : `Hide links scoring below this ${METRIC_LABEL[activeMetric]}.`}
        </p>
        {spanned && (
          <>
            <SliderField
              label="Min fragment length (aa)"
              value={minFragment}
              min={0}
              max={fragMax}
              step={1}
              onChange={(v) => setStyle({ minFragmentAa: v })}
            />
            <p className="muted">
              Hide partial-similarity links whose shared aligned region is shorter than this many residues.
            </p>
          </>
        )}
        <p className="style-group">Style</p>
        <CheckField label="Show links" checked={style.showLinks} onChange={(v) => setStyle({ showLinks: v })} />
        <CheckField label="Colour links" checked={style.colourLinks} onChange={(v) => setStyle({ colourLinks: v })} />
        <CheckField label="Straight links" checked={style.straightLinks} onChange={(v) => setStyle({ straightLinks: v })} />
        <CheckField label={`Show ${METRIC_LABEL[activeMetric]} values`} checked={style.showLinkLabels} onChange={(v) => setStyle({ showLinkLabels: v })} />
        <CheckField label="Anchor to aligned region" checked={style.anchorLinksToAligned} onChange={(v) => setStyle({ anchorLinksToAligned: v })} />
        <SliderField label="Link opacity" value={style.linkOpacity} min={0} max={1} step={0.05} onChange={(v) => setStyle({ linkOpacity: v })} />
      </Section>

      <Section title="Genes">
        <p className="style-group">CDS</p>
        <SelectField label="Shape" value={style.geneShape} options={GENE_SHAPES} onChange={(v) => setStyle({ geneShape: v })} />
        <SliderField label="CDS height" value={style.trackHeight} min={4} max={48} onChange={(v) => setStyle({ trackHeight: v })} />
        <SliderField label="Tip length" value={style.tipLength} min={0} max={48} onChange={(v) => setStyle({ tipLength: v })} />
        <SliderField label="Stroke width" value={style.geneStrokeWidth} min={0} max={4} step={0.1} onChange={(v) => setStyle({ geneStrokeWidth: v })} />
        <ColourField label="Stroke colour" value={style.geneStroke} onChange={(v) => setStyle({ geneStroke: v })} />
        <p className="style-group">Backbone</p>
        <ColourField label="Backbone colour" value={style.backboneColour} onChange={(v) => setStyle({ backboneColour: v })} />
        <SliderField label="Backbone width" value={style.backboneWidth} min={0} max={8} step={0.5} onChange={(v) => setStyle({ backboneWidth: v })} />
        <SliderField label="Backbone opacity" value={style.backboneOpacity} min={0} max={1} step={0.05} onChange={(v) => setStyle({ backboneOpacity: v })} />
        <p className="style-group">Labels</p>
        <CheckField label="Show cluster names" checked={style.showClusterNames} onChange={(v) => setStyle({ showClusterNames: v })} />
        <SliderField label="Name font size" value={style.clusterFontSize} min={6} max={28} onChange={(v) => setStyle({ clusterFontSize: v })} />
      </Section>

      <Section key={data ? "colour-data" : "colour-empty"} title="Colour" defaultOpen={!!data}>
        {data ? (
          <>
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
                <div className="btn-row">
                  <button className="btn" onClick={exportColourCSV}>Export CSV</button>
                  <label className="btn">
                    Import CSV
                    <input type="file" accept=".csv" hidden onChange={importColourCSV} />
                  </label>
                  <button className="btn" onClick={clearOverrides}>Reset</button>
                </div>
                <p className="muted">
                  <b>Export CSV</b> saves the current label→colour mapping so you can tweak it in a spreadsheet or
                  reuse the exact colours across figures. <b>Import CSV</b> reads a <code>label,colour</code> file and
                  applies matching rows as overrides. <b>Reset</b> clears all manual overrides, restoring the palette.
                </p>
              </>
            )}
          </>
        ) : (
          <p className="muted">Genes are coloured by homology group once data loads.</p>
        )}
      </Section>

      <Section title="Arrangement" defaultOpen={!!data}>
        {data ? (
          <>
            <p className="muted">
              Drag the ⠿ handle to move a cluster — sideways to slide it within its row, or up/down to move it to another row.
            </p>
            <SliderField label="Scale (px/kb)" value={style.pxPerKb} min={5} max={500} step={5} onChange={(v) => setStyle({ pxPerKb: v })} />
            <SliderField label="Cluster spacing" value={style.clusterSpacing} min={10} max={200} onChange={(v) => setStyle({ clusterSpacing: v })} />
            <CheckField label="Prevent overlap" checked={style.preventOverlap} onChange={(v) => setStyle({ preventOverlap: v })} />
            <button className="btn btn-block" onClick={clearClusterOffsets} disabled={!hasOffsets}>
              Reset horizontal positions
            </button>
          </>
        ) : (
          <p className="muted">Load data to arrange clusters into rows.</p>
        )}
      </Section>

      <Section title="Figure">
        <p className="style-group">Scale bar</p>
        <CheckField label="Show scale bar" checked={style.showScaleBar} onChange={(v) => setStyle({ showScaleBar: v })} />
        <SliderField label="Bar length (kb, 0 = auto)" value={style.scaleBarKb} min={0} max={50} step={0.5} disabled={!style.showScaleBar} onChange={(v) => setStyle({ scaleBarKb: v })} />
        <SliderField label="Bar thickness" value={style.scaleBarThickness} min={0.5} max={8} step={0.5} disabled={!style.showScaleBar} onChange={(v) => setStyle({ scaleBarThickness: v })} />
        <SliderField label="Label size" value={style.scaleFontSize} min={6} max={32} disabled={!style.showScaleBar} onChange={(v) => setStyle({ scaleFontSize: v })} />
        <p className="style-group">Colour legend</p>
        <CheckField label="Show colour legend" checked={style.showLegend} onChange={(v) => setStyle({ showLegend: v })} />
        <SliderField label="Max colours (0 = all)" value={style.maxLegendEntries} min={0} max={20} disabled={!style.showLegend} onChange={(v) => setStyle({ maxLegendEntries: v })} />
        <SliderField label="Text size" value={style.legendFontSize} min={6} max={32} disabled={!style.showLegend} onChange={(v) => setStyle({ legendFontSize: v })} />
        <SliderField label="Entry spacing" value={style.legendSpacing} min={4} max={60} disabled={!style.showLegend} onChange={(v) => setStyle({ legendSpacing: v })} />
        <p className="style-group">Canvas</p>
        <ColourField label="Background" value={style.background} onChange={(v) => setStyle({ background: v })} />
        <button className="btn btn-block" onClick={resetStyle}>Reset style</button>
      </Section>

      <Section title="Export">
        <div className="btn-row">
          <button className="btn" onClick={() => exportSVG(useStore.getState())} disabled={!data}>SVG</button>
          <button className="btn" onClick={() => exportPNG(useStore.getState())} disabled={!data}>PNG</button>
        </div>
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
