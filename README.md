# Weft

Weft is a web application for comparing gene clusters. It aligns all proteins encoded in a
set of annotated nucleotide records against each other and draws the result as a multi-row
gene map. Cross-record similarity is shown as ribbons between the genes. The figure can be
edited interactively and exported as vector or raster graphics, with the underlying
similarity data exported as tables.

![Five bacteriophage records compared in Weft; ribbons connect similar proteins, genes are coloured by functional annotation](docs/screenshot.png)

## Method

### Input

| Format | Extensions | Notes |
|---|---|---|
| GenBank | `.gbk` `.gb` `.genbank` `.gbf` `.gbff` | One file = one cluster. A multi-record file becomes one cluster with several loci. |
| GFF3 / GTF + FASTA | `.gff` `.gff3` `.gtf` + `.fa` `.fna` `.fasta` `.fas` `.faa` | Annotation and sequence files are paired by basename (e.g. `phage1.gff3` + `phage1.fna`). |

Genes are taken from CDS features. Records with no CDS features are drawn but not aligned.

### Protein comparison

Every protein is compared with every protein from the other clusters. Three methods are
available:

| Method | Algorithm | Output per protein pair |
|---|---|---|
| Global (default) | Needleman–Wunsch, parasail; BLOSUM62, gap open 11, extend 1 | One alignment |
| Local | Smith–Waterman, parasail; same scoring | Up to 5 non-overlapping regions. After each alignment the matched query residues are masked and the search is repeated; regions shorter than 5 aa are discarded. |
| DIAMOND | DIAMOND blastp, all-vs-all | Best hit by bitscore; E-value cutoff 10⁻³ |

Metrics stored for each link:

- **Identity:** identical positions / alignment length (gaps included)
- **Similarity:** positive-scoring positions / alignment length
- **Coverage:** the smaller of the two aligned fractions (query span / query length, subject span / subject length)
- **Bitscore and E-value:** DIAMOND only

In local mode, each ribbon spans only the aligned region of each protein.

### Similarity groups

Genes are joined into a group when links above a chosen threshold, on a chosen metric,
connect them, either directly or through intermediate genes. Formally, the groups are the
connected components of the thresholded gene graph (single linkage); singletons are left
ungrouped. The groups are used for colouring and ordering. They are not homology or
orthology assignments, and they change with the threshold.

### Cluster order

The initial row order comes from pairwise synteny scores between clusters:

S = (number of shared similarity groups) + 0.5 × (number of shared unordered pairs of adjacent groups)

Scores are converted to distances (max(S) − S) and clustered hierarchically (SciPy, Ward
linkage by default). The leaf order becomes the row order. With two or fewer clusters, or
when no groups are shared, the input order is kept.

## Interface

After alignment, the figure is edited client-side; changing the layout does not trigger a
new alignment. Supported operations:

- Change the link metric (identity, similarity, coverage; bitscore and E-value with DIAMOND)
  and threshold. Similarity groups are recomputed in the browser.
- Reorder clusters, move them within or between rows, and reverse their orientation.
- Align homologous genes across rows on a selected gene.
- Mark records as circular and shift the displayed origin one CDS at a time.
- Colour genes by similarity group, by cluster, by any feature qualifier (e.g. `product`,
  `function`), or by user-defined groups.
- Inspect a gene: its qualifiers, similarity group, links with metric values, and protein
  sequence.

Canvas controls:

| Input | Action |
|---|---|
| Scroll / drag background / arrow keys | Pan |
| ⌘/Ctrl + scroll, pinch, `+` `−` | Zoom |
| `0` | Fit to window |
| Hover gene | Annotation summary |
| Right-click gene | Gene inspector |
| Double-click gene | Align matching genes across rows |
| Drag ⠿ handle | Move cluster within or between rows |
| ⌘Z / ⇧⌘Z (Ctrl on Windows/Linux) | Undo / redo |

## Output

| Export | Format | Content |
|---|---|---|
| Figure | SVG, PNG | Current view; PNG at a selectable scale |
| Link table | CSV | One row per link, with all metrics |
| Cluster matrix | CSV | Number of links between each pair of clusters |
| Session | JSON | Input-derived data, links, layout, colours and style; can be reopened in Weft |

The session is also autosaved to the browser's local storage. Up to 50 undo steps are kept.

## Installation

Docker:

```bash
git clone https://github.com/kciuchcinski/weft.git
cd weft
docker build -t weft .
docker run -p 8000:8000 weft     # http://localhost:8000
```

The image contains parasail and DIAMOND. It targets `linux/amd64`, so an Apple Silicon build should be possible, but it runs under emulation and may take several minutes to start.

To build from source (requires pixi and Node.js 20), see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Limits

Default per-job limits, configurable through environment variables (see
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#configuration)):

| Parameter | Default |
|---|---|
| Clusters | 100 |
| Genes, total | 6,000 |
| Protein length | 20,000 aa |
| Upload size | 50 MB |
| Parasail: unique proteins | 800 |
| Parasail: protein length | 5,000 aa |

Exact pairwise alignment scales quadratically with the number of proteins. Use DIAMOND for
larger inputs.

## Data handling

Uploaded files are deleted from the server 30 minutes after upload. Figure state is stored
only in the user's browser and in session files the user saves.

## Citation

No publication yet. Until there is one, please cite the repository:
<https://github.com/kciuchcinski/weft>.

## Issues

Bug reports and feature requests: [GitHub Issues](https://github.com/kciuchcinski/weft/issues).

## License

[MIT](LICENSE) © 2026 Karol Ciuchciński
