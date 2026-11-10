# Weft tutorial

This tutorial rebuilds the example figure (Figure 1 of the Weft paper) from the raw GenBank
files, step by step, and then covers what changes with your own data. It takes about 15
minutes. The input files are in [`examples/OXA-232/input/`](examples/OXA-232/input/); the
finished session and figure are in [`examples/OXA-232/Figure1/`](examples/OXA-232/Figure1/).

The dataset: four complete ColKP3-type plasmids carrying *bla*OXA-232, which are the same
6,141 bp sequence deposited with different start positions, and one draft assembly in which
the plasmid is split across three contigs. See [`examples/OXA-232/README.md`](examples/OXA-232/README.md)
for accessions and how the records were chosen.

## 1. Look at the finished example

1. Open Weft and click **Load example dataset**. This opens a saved session; nothing is
   recomputed.
2. Move around the figure: drag to pan, scroll to move, ⌘/Ctrl + scroll (or pinch) to zoom,
   `0` to fit the whole figure. The **ⓘ** button at the bottom right of the canvas lists all
   shortcuts.
3. Hover over a gene for a short annotation summary. Right-click it to open the gene
   inspector: all annotation qualifiers, its similarity group, its links with their metrics,
   and the protein sequence. Similar genes are highlighted while the inspector is open.
4. Hover over a ribbon to see the metrics of that link.

Click **New** in the top bar to clear the canvas before continuing.

## 2. Load the files and run the alignment

1. Download the five `.gbk` files from `examples/OXA-232/input/`.
2. Drop them onto the canvas, or click **Choose files**. The files are listed as staged in the
   **Data & alignment** panel on the left.
3. Next to `NZ_RJTR01_YDC775-9.gbk`, tick **Split records**. Each of the file's three contigs
   then becomes its own sequence that can be moved and reversed independently. Without it,
   the whole file is drawn as one sequence.
4. Set **Alignment method** to **Global — compare whole proteins** and **Identity cutoff** to
   0.3. The cutoff decides which links are kept and how genes are grouped into similarity
   groups.
5. Click **Run alignment on 5 files**. When the job finishes, the figure is drawn with an
   initial row order based on shared gene content and gene order.

## 3. Line up the circular plasmids

The four complete plasmids start at different positions, so the same genes sit in different
places in each row.

1. Open **Sequences → Sequence list**. Click the ring icon next to each of the four complete
   plasmids to mark it as circular.
2. Use **‹** and **›** next to each circular sequence to shift its displayed origin one CDS at a
   time, until every row starts with the same gene (here, the replication protein). The arrow
   icon restores a sequence's original origin; **Reset all origins** restores all of them.
3. To check the alignment, double-click a gene (for example OXA-232): matching genes in the
   other rows are lined up under it.

## 4. Arrange the rows

1. Each sequence has a **⠿** handle on the canvas. Drag it sideways to slide the sequence along
   its row, or vertically to move it into another row. Put the three YDC775-9 contigs next to
   each other in one row.
2. Use **⇄** on the canvas to reverse a sequence. Reverse `NZ_RJTR01000007` so that its genes
   point the same way as in the other rows.
3. To leave a sequence out of the figure and all exports, untick it in the sequence list.
4. **Sequences → Layout** sets the scale (px per kb) and row spacing; tick **Manually adjust
   spacing** to set the gap above each row separately.

Every edit can be undone with ⌘Z / Ctrl+Z (redo: ⇧⌘Z / Ctrl+Shift+Z), or icons found on the right side of the top bar.

## 5. Filter the links

**Similarity links → Filtering** controls which ribbons are drawn:

- **Metric**: identity, similarity or coverage (plus bit score and E-value with DIAMOND).
- **Hide links below**: hides ribbons below the chosen value of that metric.

These controls change only the displayed ribbons. Similarity groups, and therefore the group
colours, come from the identity cutoff used for the alignment; to change them, run the
alignment again with a different cutoff. **Similarity links → Appearance** switches ribbons on
or off, colours them by their genes, draws them straight, or shows the metric value on each
ribbon.

## 6. Colour the genes

In **Colours & legend**, **Colour by** offers four modes:

- **Group**: each similarity group gets its own colour. In the legend below, type in a group's
  name field to rename it (for example "Rep" or "OXA-232") and click its swatch to change the
  colour. The names appear in the figure legend.
- **Sequence**: one colour per sequence.
- **Field**: colour by any annotation qualifier in the input, chosen under **GenBank field**
  (for example `product` or `function`).
- **Custom**: click **+ New group**, name it, select it, then click genes on the canvas to add
  them to the group or remove them. To stop adding genes, click on the dot found next to the group in the panel.

**Save CSV** stores the current label-to-colour mapping, and **Load CSV** applies it to another
figure. **Figure style** sets gene shape, labels, sequence names, the legend and the scale bar.

## 7. Save and export

- **Save session** (top bar) downloads the whole figure (data, layout, colours and style) as a
  `.json` file. **Open session** reopens it, on any computer. The current session is also
  autosaved in your browser.
- **Export → Figure → SVG** or **PNG** saves the figure. SVG files can be edited in Inkscape,
  Illustrator or Affinity Designer.
- **Export → Similarity data → Alignment CSV** saves every link with its metrics;
  **Matrix CSV** saves the number of links between each pair of sequences.

Compare your result with `examples/OXA-232/Figure1/`.

## Using your own data

- **Formats.** GenBank files (`.gbk`, `.gb`, `.genbank`, `.gbf`, `.gbff`), or GFF3/GTF files
  paired with a FASTA file of the same base name (for example `phage1.gff3` + `phage1.fna`).
  Genes are taken from CDS features. Weft has been tested with output from Bakta, Prokka,
  Pharokka and Phold. It is designed for prokaryotic and viral annotations; spliced
  (eukaryotic) genes are not supported.
- **One file = one sequence**, unless **Split records** is ticked for that file. Use it for draft
  assemblies so that contigs can be placed and reversed individually.
- **Choosing a method.**
  - *Global* (default): whole proteins, one link per pair.
  - *Local*: also finds proteins that share only part of their sequence, such as one domain;
    each matching region gets its own ribbon.
  - *DIAMOND*: for inputs above the exact-alignment limit (800 unique proteins, or proteins
    longer than 5,000 aa).
- **Limits on the public instance.** Up to 100 sequences, 6,000 genes in total and 50 MB of
  uploads per job.
- **Your data.** Uploaded files are deleted from the server 30 minutes after upload. The figure
  stays in your browser and in session files you save.

## Issues and development

Questions and bug reports: [GitHub Issues](https://github.com/kciuchcinski/weft/issues).
A useful report includes:

- the Weft version, shown at the bottom of the left panel;
- your browser and operating system;
- what you did, what you expected and what happened;
- the input files or, if the problem appears after alignment, the session file (**Save
  session**). If the data cannot be shared, a smaller public example that shows the same
  problem is enough.

To run Weft on your own computer, for example for confidential data or inputs above the public
limits, see [Installation](README.md#installation) in the README. A local instance is the same
application, and its job limits can be raised through environment variables
([Limits](README.md#limits)). Pull requests are welcome; please run the backend tests and the
frontend build (see the README) before submitting one.
