# Syntenic — Functional Specification

> A browser-based tool for generating publication-quality **gene cluster comparison figures**.
> New, standalone app (not a fork of clinker). Server does the heavy lifting; the browser is a thin, fast, canvas-first client.

Legend: **[MVP]** = first release / build order, **[Later]** = layers on after the MVP proves the end-to-end path.

---

## 0. Scope & assumptions

Syntenic covers clinker's use case (gene cluster comparison figures) plus five requested capabilities: **multiple entries per line**, **per-cluster colour control**, **colour palettes**, **alternative similarity metrics**, and **speed**. The user interacts only through a browser; a server parses inputs, computes similarity, groups and orders clusters, and returns a figure description the client renders, refines, and exports.

**Stack (decided):** Python + FastAPI backend; DIAMOND/MMseqs2 for heavy alignment; async job model; React + TypeScript client; Canvas/WebGL interactive rendering with SVG export.

### Glossary
- **Cluster** — one input record/file: a contiguous genomic region shown as one track.
- **Locus** — a sub-region within a cluster (a scaffold/contig or coordinate range); a cluster has one or more.
- **Gene** — a CDS/gene feature with coordinates, strand, translation, and free-form name qualifiers.
- **Link** — a similarity relationship between two genes in different clusters, carrying a bundle of metrics.
- **Group** — a homology group: a set of genes treated as the same "gene", used for colouring and legend entries.
- **Session** — the complete serializable state (data + all view/style settings) for save/load/share.

---

## 1. Input & ingestion

### 1.1 Accepted formats
- **GenBank** (`.gbk .gb .genbank .gbf .gbff`) — primary; extract CDS features, translations, qualifiers. **[MVP]**
- **GFF3 + FASTA** — GFF3 (`.gff .gff3 .gtf`) paired with a nucleotide FASTA; trace CDS→gene for true coordinates. **[MVP]**
- **EMBL** — via BioPython. **[Later]**
- **Protein multi-FASTA per cluster** — no coordinates; genes laid out evenly. **[Later]**
- **Precomputed session JSON** — reload a saved Syntenic session (§11). **[MVP]**
- **Precomputed alignment import** — user supplies their own all-vs-all table (BLAST/DIAMOND tabular) to skip computation. **[Later]**

### 1.2 Upload UX **[MVP]**
- Drag-and-drop zone plus file picker; accept **multiple files at once** and **whole folders** (`webkitdirectory`).
- Progress per file (uploading → queued → parsing → done/error).
- **Paste** GenBank/GFF text into a textarea as an alternative to files.
- **Example datasets** — bundled samples to try the app in one click.
- File size / count guardrails with clear messages (configurable server limits, §14).

### 1.3 Parsing options (per upload)
- **Feature selection** — which feature types to extract (default `CDS`; allow `gene`, custom). **[MVP]** (non-CDS **[Later]**)
- **Coordinate ranges** — restrict a scaffold to `scaffold:start-end`; multiple ranges; addable after seeing the cluster. **[MVP]**
- **Records → clusters mapping** — one multi-locus cluster per file, or one cluster per record. **[MVP]**
- **Circular origin handling** — detect circular topology and shift features spanning the origin; toggle off. **[MVP]**
- **Label qualifier priority** — ordered preference for the display label (`protein_id, locus_tag, gene, ID, product…`); all qualifiers retained for later label switching. **[MVP]**
- **Translation source** — use `/translation` qualifier else translate; report genes with no usable sequence. **[MVP]**
- **Minimum genes per cluster** — warn/skip clusters below a threshold. **[MVP]**

### 1.4 Per-cluster metadata
- Editable **metadata table**: cluster name plus arbitrary columns (taxon, organism, source, tags). **[MVP light]**
- Import metadata by CSV (join on filename or a chosen key). **[Later]**
- Metadata feeds **colour-by-metadata**.

### 1.5 Validation & diagnostics **[MVP]**
- Structured per-file parse report: features found, genes with/without translation, unmatched FASTA for GFF, malformed records.
- Non-fatal issues are warnings; the app proceeds with what parsed. Fatal errors name the file and reason.

---

## 2. Similarity computation (backend)

Similarity is a **pluggable engine**; every link stores the **full metric bundle** so the user can switch the *active* metric in the UI without recomputation.

### 2.1 Engines
| Engine | Speed | Metrics produced | Use |
|---|---|---|---|
| **DIAMOND** all-vs-all **[MVP]** | very fast | identity, coverage, bitscore, e-value | default for most inputs |
| **MMseqs2** all-vs-all **[MVP/fast-follow]** | very fast, tunable sensitivity | identity, coverage, bitscore, e-value | large N / remote homology |
| **k-mer MinHash → Jaccard** **[Later]** | near-instant | Jaccard similarity | huge N, quick ordering, alignment-free |
| **Banded SW / NW** (parasail/BioPython) **[Later]** | slow, precise | identity, similarity, coverage, score | small sets, exact numbers, matrix choice |

### 2.2 Parameters (Advanced panel; sane defaults) **[MVP for DIAMOND set]**
- **Scope**: all-vs-all (default) or adjacent-only (align each cluster to display neighbours — much cheaper for large N).
- **Identity / coverage / e-value cutoffs** for saving a link (defaults ≈ identity ≥ 0.3, e-value ≤ 1e-3).
- **Substitution matrix** (BLOSUM45/62/80, PAM) and **gap open/extend** where supported.
- **Sensitivity preset** (fast / sensitive / very-sensitive) for MMseqs2/DIAMOND.
- **Symmetry & best-hit**: keep all hits, or reciprocal-best-hit only.
- Self-links excluded; intra-cluster paralog links optional **[Later]**.

### 2.3 Performance behaviours **[MVP]**
- **Sequence deduplication** — identical translations aligned once, results fanned out.
- **Result caching** — cache by content hash of (sequences + engine + params).
- **Incremental add** — adding clusters aligns only the new pairs.

### 2.4 Metric bundle per link **[MVP]**
Every link carries `{ identity, similarity, coverage, bitscore, evalue, jaccard? }` (nulls where an engine doesn't produce one). The UI's **active metric selector** drives colouring, filtering thresholds, link opacity, grouping, and ordering — all client-side, live.

---

## 3. Homology grouping

- **Graph clustering** **[MVP]**: build a gene graph from links above the active threshold; connected components via disjoint-set (default). **MCL / Louvain [Later]** for dense graphs.
- **Threshold-linked & live** **[MVP]**: changing the active metric or threshold re-groups without a server round-trip.
- **Function-based seeding** **[MVP]**: import a 2-column CSV (`gene,function`) to pre-seed groups, then extend by links.
- **Reference-based grouping** **[Later]**: groups defined by best hit to a chosen reference cluster.
- **Manual editing** **[Later]**: merge/split/move genes between groups, rename; edits sticky across re-grouping.
- **Singletons**: unlinked genes form their own greyed group by default (toggle).

---

## 4. Ordering & arrangement

- **Synteny-based ordering** **[MVP]**: score cluster pairs by shared homologues weighted by gene-pair contiguity (`S = h + i·s`), build a distance matrix, hierarchically cluster (Ward/average/complete — selectable), order by dendrogram leaves. Uses the **active metric**.
- **Order sources** **[MVP]**: computed optimal, input/file order, manual drag-to-reorder, by a metadata column.
- **Dendrogram display** **[Later]**: show/collapse the tree; export **Newick**.
- **Anchor alignment** **[MVP]**: click a gene/group to horizontally align all clusters on that homolog.
- **Lock order** **[MVP]**: freeze arrangement so later edits don't reflow it.

---

## 5. Layout engine

- **Rows** **[MVP]** — classic: one cluster per full-width track, stacked; homologous genes aligned; links between adjacent tracks. Best for detailed synteny comparison.

Controls: track sizing, inter-cluster and inter-locus spacing.

---

## 6. UI / application shell

Clean, canvas-first. Chrome stays out of the way of the figure.

- **Top bar (~44px, minimal)** **[MVP]**: app name/logo left; then just **New / Load session**, **Save**, **Export (SVG/PNG)**, and a compact **job-status indicator** (spinner + progress text). No menu clutter.
- **Left control panel (primary chrome)** **[MVP]**: fixed-width, **resizable**, fully **collapsible**. All controls in collapsible accordion sections in workflow order:
  1. **Input & data** (files, examples, metadata)
  2. **Similarity** (engine, params, active metric)
  3. **Grouping & ordering** (threshold, method, anchor, order source)
  4. **Colour** (target, palette, selection, import/export)
  5. **Style** (arrows, labels, links, scale/legend)
  6. **Export**
  - Sections collapse independently; panel scrolls; collapsing the whole panel hands full width to the canvas. In-panel control search **[Later]**.
- **Main canvas view** **[MVP]**: fills remaining space; minimal, no gridlines by default; **zoom/pan**; on-canvas direct manipulation (drag, lasso, select). Small floating zoom % / fit-to-view control bottom-right. Optional right-side contextual **inspector** for a selected gene/cluster **[Later]** (default keeps the canvas clean).
- **Responsive** **[MVP]**: left panel collapses to a drawer on narrow screens.
- **Theme** **[MVP]**: light default, dark optional; canvas background configurable.
- **Design language**: generous whitespace, subtle borders, publication-neutral chrome so the figure is the focus.

---

## 7. Rendering & figure elements

- **Renderer** **[MVP]**: Canvas/WebGL (PixiJS or regl) for interaction; virtualized so only visible elements draw; smooth zoom/pan. **SVG serialization on export** (§10) for vectors.
- **Gene arrows** **[MVP]**: to-scale polygons with strand direction; configurable body height, tip height, tip length, stroke colour/width; non-scaled mode for tiny/huge genes.
- **Loci** **[MVP]**: track segment with baseline; inter-locus gaps; **flip locus** (reverse-complement view); **resize/trim** ends by dragging handles.
- **Links between clusters** **[MVP]**: ribbons or lines connecting homologous genes across adjacent tracks; styles — curved ribbon / straight ribbon / line; **best-only** toggle; opacity/colour driven by active metric; live **identity threshold** slider; optional per-link value labels with background.
- **Scale bar** **[MVP]**: configurable length (bp), height, font.
- **Colour bar** **[MVP]**: legend for continuous metric colouring (e.g. identity 0→1).
- **Group legend** **[MVP]**: one entry per group with swatch + label; click to edit colour/name; right-click to hide group + its links.
- **Gene labels** **[MVP]**: toggle; choose qualifier; rotation, anchor (start/middle/end), position (top/middle/bottom), font size, spacing, per-label override.
- **Cluster & locus names** **[MVP]**: editable, font sizes, show/hide locus coordinates, align labels across tracks.
- **Tooltips** **[MVP]**: hover a gene/link → name, coordinates, strand, group, all qualifiers, per-metric values.

---

## 8. Colour system

Covers requirements 2 and 3.

- **Colour target** **[MVP]** — colour **by homology group** (default), **by cluster**, **by locus**, or **by a continuous metric** (e.g. % identity to a reference → sequential palette + colour bar). Switchable live.
- **Selection to colour** **[MVP]** — select clusters/groups by **click**, **shift-click** (range), **lasso**, or **query** (name/metadata); assign a colour; **lock** it so re-grouping/palette changes don't override.
- **Palettes** **[MVP]**:
  - Categorical: **Tableau10/20, Set1/2/3, Okabe–Ito (colourblind-safe), Paired**.
  - Sequential/continuous: **viridis, magma, Blues, Greens** for metric-driven colouring.
  - "Apply palette" maps the active target's items to colours in order; reshuffle; reverse.
- **Manual per-item colour** **[MVP]**: colour picker on any group/cluster/gene; overrides palette.
- **Colour map import/export** **[MVP]**: CSV of `key,colour` (group/function/cluster → hex), round-trippable.
- **Contrast helpers** **[Later]**: auto stroke/label colour for legibility; colourblind simulation preview.

---

## 9. Interaction & editing

- Drag cluster names/tracks to **reorder**. **[MVP]**
- Drag locus box to **move**, handles to **resize**, double-click to **flip**. **[MVP]**
- Click gene to **anchor** the figure on its group. **[MVP]**
- Right/double-click gene to **edit its label**. **[MVP]**
- Click cluster names & legend entries to **rename**. **[MVP]**
- Click legend swatches to **recolour**; right-click to **hide group + links**. **[MVP]**
- Click scale-bar text to **set length**. **[MVP]**
- **Search** genes/clusters by name → highlight/zoom. **[MVP]**
- **Show/hide** individual clusters, loci, groups, links. **[MVP]**
- **Multi-select + bulk actions** (colour, hide, move). **[MVP for colour; others Later]**
- **Undo/redo** for edits. **[Later, high-value]**

---

## 10. Figure styling controls (exhaustive knob list) **[MVP]**

Grouped in the Style section, all live, all persisted:
- **Arrangement**: scale factor, vertical (cluster) spacing, inter-locus spacing, show-genes-to-scale.
- **Clusters**: align labels, hide locus coordinates, cluster-name font size, locus-name font size.
- **Gene arrows**: body height, tip height, tip length, stroke colour, stroke width.
- **Gene labels**: show, rotation, start point, anchor, font size, label qualifier, spacing, position.
- **Scale bar**: font size, height, length (bp), top margin.
- **Colour bar**: font size, height, top margin.
- **Legend**: font size, entry height, left margin, show/hide.
- **Links**: show, best-only, as-line, straight, group-colour vs metric-colour, stroke width, identity threshold, labels + label font size/position/background.
- **Canvas/theme**: background colour, light/dark UI, figure margins.
- **Reset to defaults** per section and globally.

---

## 11. Export & reports

- **SVG** **[MVP]** — vector, current state, hidden elements removed, sized to content bounding box.
- **PNG** **[MVP]** — raster at selectable DPI/scale.
- **PDF** **[Later]**.
- **Session JSON** **[MVP]** — full data + settings for reload/share.
- **Copy to clipboard** **[Later]** — PNG image.
- **Alignment table** **[MVP]** — CSV/TSV of links with all metrics; configurable delimiter/decimals.
- **Similarity matrix** **[MVP]** — cluster×cluster synteny/identity matrix, CSV; normalized/distance options.
- **Newick tree** **[Later]** — the ordering dendrogram.

---

## 12. Sessions & sharing

- **Save/Load session** **[MVP]** — JSON containing `{clusters, loci, genes, links(metrics), groups, style, order}`.
- **Autosave to browser** **[MVP]** — localStorage/IndexedDB so a refresh doesn't lose work.
- **Server-side sessions & share URLs** **[Later]** — store under an ID; open by URL; optional read-only links; expiry policy.
- **Versioned schema** **[MVP]** — a `schemaVersion` field with a migration path so old sessions keep loading.

---

## 13. Backend API (sketch)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Liveness / limits |
| `/api/examples` | GET | List/serve bundled example datasets |
| `/api/upload` | POST | Accept files/text; return upload token + parse report |
| `/api/parse` | POST | Parse uploaded inputs with options → cluster/gene JSON |
| `/api/jobs` | POST | Start a similarity job (engine + params + scope) → `job_id` |
| `/api/jobs/{id}` | GET | Poll status / progress / result |
| `/api/jobs/{id}/events` | WS | Stream progress; final `data.json` |
| `/api/jobs/{id}` | DELETE | Cancel a running job |
| `/api/sessions` | POST/GET | **[Later]** save/fetch server sessions |

All heavy work (parse, align, group, order) is server-side; responses are pure data. The client owns rendering, layout, colour, and style.

---

## 14. Compute infrastructure **[MVP]**

- **Async job model**: submit → `job_id` → progress via WebSocket (poll fallback) → result. Alignment is too slow for request/response.
- **Queue**: RQ/Celery + Redis for real deployments; a bounded thread pool for single-box/dev.
- **Job lifecycle**: queued / running / succeeded / failed / cancelled; per-job logs surfaced to the UI on failure.
- **Resource guards**: max clusters, max total genes, max sequence length, max concurrent jobs, per-job timeout — configurable, clear UI errors.
- **Temp storage & cleanup**: uploads and intermediates in a scratch dir with TTL cleanup.

---

## 15. Non-functional requirements

- **Performance** **[MVP]**: parse + DIAMOND all-vs-all for ~20 clusters / a few thousand genes in seconds; interactive figure smooth into the tens-of-thousands of elements via virtualization.
- **Limits**: documented caps with graceful degradation (suggest adjacent-only scope or k-mer engine when over budget).
- **Security**: validate/sanitize uploads; never execute uploaded content; run aligners with fixed args (no shell injection); size/type limits; isolate per-job temp dirs; optional auth for hosted deployments.
- **Privacy**: local/offline Docker deployment so sequences never leave the user's machine — important for unpublished data.
- **Accessibility**: keyboard navigation, ARIA labels, colourblind-safe default palette, sufficient contrast.
- **Browser support**: current Chrome/Firefox/Safari/Edge; WebGL required, Canvas2D fallback.
- **Deployment**: single **Docker image** (FastAPI + DIAMOND/MMseqs2 binaries + built client) + docker-compose with Redis; also a "lite" mode (thread pool, no Redis).
- **Observability**: structured logs, job metrics, error reporting.

---

## 16. MVP build order

1. **Backend pipeline**: upload → parse (GenBank + GFF/FASTA) → **DIAMOND all-vs-all** → group (disjoint-set) → order (synteny + hierarchical) → `data.json`, as an **async job with progress**.
2. **Client core**: upload UX + job progress; Canvas renderer with **rows** layout; gene arrows, loci, links, scale bar, legend; zoom/pan; the application shell (§6).
3. **Metric selector** wired to the per-link metric bundle (identity/bitscore/coverage/e-value) driving colour, threshold, ordering — live.
4. **Colour system**: targets (group/cluster), lasso + click selection, palettes incl. colourblind-safe, manual picker, CSV import/export.
5. **Styling panel** (§10) + **SVG/PNG export** + **session save/load**.

Everything **[Later]** (MMseqs2/k-mer engines, dendrogram/Newick, MCL grouping, manual group editing, server sessions/share URLs, undo/redo, EMBL/protein-FASTA inputs) layers on after the MVP.

---

## 17. Open questions (won't block the MVP)

- **Deployment target** — hosted multi-user service, or primarily self-hosted/offline Docker tool? (Drives auth, sessions, privacy work.)
- **Default aligner** — DIAMOND (simplest to bundle) vs MMseqs2 (more sensitive) as day-one default.
- **Non-CDS features** — draw tRNA/rRNA/regulatory features, or CDS-only like clinker?
