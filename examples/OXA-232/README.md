# OXA-232 / ColKP3 plasmids

Five GenBank files (seven records) of small ColKP3-type plasmids carrying blaOXA-232. This is
the dataset behind Figure 1 and Weft's in-app "Load example dataset". The canonical plasmid is
6,141 bp (reference pOXA-232, JX423831; Potron et al. 2013). Records were downloaded from NCBI
nuccore on 2026-10-22.

## Inputs (`input/`)

Coordinates are 1-based, in each record's own numbering. *Offset* is where JX423831's first base
falls in the record (found by matching JX423831's first 40 bp).

| File | Accession | Host | Length | Offset | blaOXA-232 CDS |
|---|---|---|---|---|---|
| `OY978238_KP4482023BGR.gbk` | OY978238.1 | *K. pneumoniae* | 6,141 bp, circular | 276 | 2953..3750 (+) |
| `CP012562_pUCLAOXA232-1.gbk` | CP012562.1 | *K. pneumoniae* | 6,141 bp, circular | 353 | 3030..3827 (+)¹ |
| `NZ_CP092341_pKPN20-5.gbk` | NZ_CP092341.1 | *K. pneumoniae* | 6,141 bp, circular | 1733 | 4410..5207 (+) |
| `CP135483_pIsolateE_B.gbk` | CP135483.1 | *K. pneumoniae* | 6,141 bp, circular | 2022 | 4699..5496 (+) |
| `NZ_RJTR01_YDC775-9.gbk` | 3 WGS contigs, below | *K. ornithinolytica* | 6,644 bp total, linear | — | on NZ_RJTR01000044.1: 1823..2620 (+) |

¹ Annotated only as "beta-lactamase" (2013 PGAP).

The four complete plasmids have identical sequence: each is a rotation of the others. They
differ only in where the record starts, and in their annotation pipelines (7–8 CDS, different
product names).

`NZ_RJTR01_YDC775-9.gbk` holds one short-read assembly (strain YDC775_9, Illumina/CLC) whose
plasmid is split across three contigs. They are listed in plasmid order, in their deposited
orientation. Approximate placement on NZ_CP092341.1, from 25-mer matches:

| Contig | Length | Strand | Span on NZ_CP092341.1 |
|---|---|---|---|
| NZ_RJTR01000007.1 | 2,591 bp | − | 5737..6141 + 1..2186 (wraps the origin) |
| NZ_RJTR01000067.1 | 795 bp | + | 1954..2748 |
| NZ_RJTR01000044.1 | 3,258 bp | + | 2588..5845 |

Neighbouring contigs overlap by about 100–230 bp.

## Selection rule

The representatives were chosen at random: four complete plasmids from the NCBI complete, circular 6,141 bp records that mention OXA-232, and one draft assembly whose plasmid is split across contigs.

So the set covers the two input problems Weft is built for: the same circular plasmid deposited with different start positions, and one plasmid split across several contigs.

## Figure 1 (`Figure1/`)

- `Figure1-weft-session.json`: the saved Weft session. A copy is the app's bundled example
  (`frontend/public/example_session.json`). Open it in Weft to edit the figure.
- `Figure_1.svg`: the exported figure.
- `Figure1-weft-alignment-table.csv` and `Figure1-weft-similarity-matrix.csv`: data exports from the same session.

The session uses parasail (global mode, identity ≥ 0.3, E ≤ 1e-3) and has one cluster per row, with the three YDC775_9 contigs on one row. NZ_RJTR01000007 is flipped. OY978238 and pUCLAOXA232-1 are marked circular,  ith the origin moved back by one CDS, so their last CDS is drawn first.
