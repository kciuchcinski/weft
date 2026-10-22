import { useMemo, useState } from "react";
import { useStore } from "../state/store";
import { computeColours } from "../render/palette";
import { formatMetric, metricLowerIsBetter, qualifierEntries } from "../render/layout";
import type { Cluster, Gene, Locus, MetricKey } from "../types";

// Display names for link metrics, matching the ribbon hover tooltip.
const METRIC_LABELS: Record<string, string> = {
  identity: "Identity",
  similarity: "Similarity",
  coverage: "Coverage",
  bitscore: "Bit score",
  evalue: "E-value",
  jaccard: "Jaccard",
};

interface Placed {
  gene: Gene;
  cluster: Cluster;
  locus: Locus;
}

/** Break a protein sequence into fixed-width lines for FASTA output. */
function wrapFasta(seq: string, width = 60): string {
  const lines: string[] = [];
  for (let i = 0; i < seq.length; i += width) lines.push(seq.slice(i, i + width));
  return lines.join("\n");
}

/**
 * Everything Weft knows about one protein: its position, every annotation
 * qualifier (never truncated — the hover tooltip is the abridged view), the
 * similarity group it landed in, its similarity links, and its translation.
 *
 * Rendered as an overlay docked inside the canvas rather than as a third layout
 * column, so opening it doesn't resize the canvas and shift the figure.
 */
export default function GeneInspector() {
  const data = useStore((s) => s.data);
  const selectedGene = useStore((s) => s.selectedGene);
  const selectGene = useStore((s) => s.selectGene);
  const activeMetric = useStore((s) => s.activeMetric);
  const colourBy = useStore((s) => s.colourBy);
  const paletteName = useStore((s) => s.paletteName);
  const overrides = useStore((s) => s.overrides);
  const colourField = useStore((s) => s.colourField);
  const customGroups = useStore((s) => s.customGroups);
  const maxLegendEntries = useStore((s) => s.style.maxLegendEntries);

  const [copied, setCopied] = useState<string | null>(null);

  // uid → the gene plus the cluster and locus it sits in, so the header can name
  // where the protein came from and link rows can name their partner's sequence.
  const index = useMemo(() => {
    const m = new Map<string, Placed>();
    data?.clusters.forEach((cluster) =>
      cluster.loci.forEach((locus) => locus.genes.forEach((gene) => m.set(gene.uid, { gene, cluster, locus }))),
    );
    return m;
  }, [data]);

  // The same colour resolution the canvas uses, so the swatch here always matches
  // the arrow on the figure.
  const colours = useMemo(
    () =>
      data
        ? computeColours(data, colourBy, paletteName, overrides, colourField, customGroups, maxLegendEntries)
        : null,
    [data, colourBy, paletteName, overrides, colourField, customGroups, maxLegendEntries],
  );

  const entry = selectedGene ? index.get(selectedGene) : null;

  // Similar proteins (linked to the selected one), best match first under the active metric.
  const partners = useMemo(() => {
    if (!data || !entry) return [];
    const uid = entry.gene.uid;
    const lower = metricLowerIsBetter(activeMetric);
    const rows = data.links
      .filter((l) => l.query === uid || l.target === uid)
      .map((l) => ({
        link: l,
        partner: index.get(l.query === uid ? l.target : l.query) ?? null,
        value: l.metrics[activeMetric],
      }));
    return rows.sort((a, b) => {
      // Links missing the active metric sink to the bottom either way.
      if (a.value == null) return b.value == null ? 0 : 1;
      if (b.value == null) return -1;
      return lower ? a.value - b.value : b.value - a.value;
    });
  }, [data, entry, index, activeMetric]);

  if (!data || !entry) return null;

  const { gene, cluster, locus } = entry;
  const group = data.groups.find((g) => g.genes.includes(gene.uid));
  const bp = gene.end - gene.start;
  const aa = gene.translation?.length ?? 0;
  const strand = gene.strand < 0 ? "−" : gene.strand > 0 ? "+" : "?";
  const fields = qualifierEntries(gene);

  const copy = (what: string, text: string) => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(what);
        setTimeout(() => setCopied((c) => (c === what ? null : c)), 1400);
      },
      () => setCopied("failed"),
    );
  };

  return (
    <aside className="gene-inspector">
      <header className="gi-head">
        <div className="gi-title-wrap">
          <h2 className="gi-title">{gene.label}</h2>
          <p className="gi-sub">
            {cluster.name}
            {locus.name !== cluster.name && <> · {locus.name}</>}
          </p>
        </div>
        <button className="icon-btn" title="Close (Esc)" onClick={() => selectGene(null)}>
          ✕
        </button>
      </header>

      <div className="gi-body">
        <dl className="gi-facts">
          <dt>Position</dt>
          <dd>
            {gene.start.toLocaleString()}–{gene.end.toLocaleString()} bp ({strand})
          </dd>
          <dt>Length</dt>
          <dd>
            {bp.toLocaleString()} bp{aa > 0 && <> · {aa.toLocaleString()} aa</>}
          </dd>
          {group && (
            <>
              <dt>Similarity group</dt>
              <dd className="gi-group">
                <span className="gi-swatch" style={{ background: colours?.gene.get(gene.uid) ?? "#cbd0d6" }} />
                {group.label}
                <span className="gi-count">{group.genes.length} genes</span>
              </dd>
            </>
          )}
        </dl>

        <section className="gi-section">
          <h3>Annotations {fields.length > 0 && <span className="gi-count">{fields.length}</span>}</h3>
          {fields.length ? (
            <dl className="gi-fields">
              {fields.map(([k, v]) => (
                <div className="gi-field" key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="muted">This feature carries no qualifiers.</p>
          )}
        </section>

        <section className="gi-section">
          <h3>
            Similar proteins {partners.length > 0 && <span className="gi-count">{partners.length}</span>}
          </h3>
          {partners.length ? (
            <ul className="gi-links">
              {partners.map(({ link, partner }) => (
                <li key={link.uid}>
                  <button
                    className="gi-link-row"
                    disabled={!partner}
                    title={partner ? "Inspect this protein" : undefined}
                    onClick={() => partner && selectGene(partner.gene.uid)}
                  >
                    <span className="gi-link-name">{partner?.gene.label ?? "—"}</span>
                    <span className="gi-link-cluster">{partner?.cluster.name ?? ""}</span>
                    <span className="gi-link-metrics">
                      {(Object.keys(link.metrics) as MetricKey[])
                        .filter((k) => link.metrics[k] != null)
                        .sort((a, b) => (a === activeMetric ? -1 : b === activeMetric ? 1 : 0))
                        .map((k) => (
                          <span key={k} className={k === activeMetric ? "gi-metric active" : "gi-metric"}>
                            {METRIC_LABELS[k] ?? k} {formatMetric(link.metrics[k], k)}
                          </span>
                        ))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No links to proteins in other sequences pass the current alignment settings.</p>
          )}
        </section>

        {aa > 0 && (
          <section className="gi-section">
            <h3>Translation</h3>
            <pre className="gi-seq">{gene.translation}</pre>
            <div className="btn-row">
              <button className="btn btn-sm" onClick={() => copy("seq", gene.translation ?? "")}>
                {copied === "seq" ? "Copied" : "Copy sequence"}
              </button>
              <button
                className="btn btn-sm"
                onClick={() => copy("fasta", `>${gene.label}\n${wrapFasta(gene.translation ?? "")}`)}
              >
                {copied === "fasta" ? "Copied" : "Copy FASTA"}
              </button>
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}
