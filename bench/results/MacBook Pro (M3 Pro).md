| Size | CDS | Shape | Total aa | Mean aa | Global | Local | DIAMOND |
|---|---|---|---|---|---|---|---|
| Small | 50 | 5 × 10 | 10,014 | 200 | 0.04 (0.04–0.07) | 0.08 (0.06–0.08) | 0.06 (0.06–0.07) |
| Medium | 200 | 10 × 20 | 39,537 | 198 | 0.59 (0.58–0.63) | 0.63 (0.62–0.66) | 0.17 (0.11–0.18) |
| Large | 800 | 20 × 40 | 144,844 | 181 | 7.79 (7.74–8.22) | 8.32 (8.29–8.37) | 0.37 (0.33–0.42) |
| Very large | 6,000 | 30 × 200 | 1,143,980 | 191 | — | — | 2.97 (2.28–3.20) |

Median wall-clock seconds over 5 runs (range in brackets), after one warmup run, measured against the Weft API 1.0.0-rc2 on the same machine. Each run is one complete job (parse, align, group, order, result download); upload not timed. Global and local use parasail on a single thread; DIAMOND (blastp, default sensitivity) uses all logical CPUs. — : above Weft's 800-protein limit for exact alignment.

- Apple M3 Pro, 5 performance + 6 efficiency cores, 36 GB RAM, macOS 26.6.2

Inputs: the first n CDS of each of the first k genomes of NC_000866.4, NC_004928.1, NC_010105.1, NC_014595.1, NC_028686.1, NC_020416.1, NC_048849.1, NC_027331.1, NC_014662.1, NC_019909.1, NC_041996.1, NC_015250.1, NC_028940.1, NC_055743.1, NC_008515.1, NC_018855.1, NC_012741.1, NC_014792.1, NC_031087.1, NC_026607.2, NC_070776.1, NC_028857.1, NC_023561.1, NC_028820.1, NC_055728.1, NC_012635.1, NC_024124.2, NC_014260.1, NC_028894.1, NC_031095.1 (NCBI RefSeq, Tevenvirinae).
