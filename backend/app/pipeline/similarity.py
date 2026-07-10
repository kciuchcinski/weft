"""Similarity engines. Each returns cross-cluster links with a full metric bundle (SPEC §2).

- ``diamond``  — fast DIAMOND all-vs-all blastp (default); whole-gene links.
- ``parasail`` — exact pairwise alignment (clinker-style). ``mode="global"`` gives one
  identity/similarity per pair (Needleman–Wunsch); ``mode="local"`` (Smith–Waterman)
  emits one link per shared sub-region (HSP) carrying its aligned span, so partial
  similarity — e.g. 100 % identity over half the protein — renders as a narrowed ribbon.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Callable, Optional

from app.core.models import Cluster, Link, LinkMetrics

try:
    import parasail
except ImportError:  # optional — only the parasail engine needs it
    parasail = None

ENGINES = ("diamond", "parasail")

Progress = Optional[Callable[[float, str], None]]

# parasail alignment settings — BLOSUM62 with BLASTP-default affine gaps (parasail
# penalties are positive magnitudes).
_GAP_OPEN = 11
_GAP_EXTEND = 1
# Guardrails: exact O(n²·L²) alignment is far more expensive than DIAMOND, so cap
# the work and steer large inputs back to DIAMOND rather than hang.
_MAX_PARASAIL_SEQS = 800  # unique protein sequences (after dedup)
_MAX_PARASAIL_LEN = 5000  # residues per protein
_MAX_HSPS = 5             # local mode: max sub-regions reported per protein pair
_MIN_HSP_AA = 5           # ignore trivially short local regions

# DIAMOND tabular columns we request (outfmt 6).
_OUTFMT = ["qseqid", "sseqid", "pident", "ppos", "evalue", "bitscore", "qcovhsp", "scovhsp"]

_SENSITIVITY = {
    "fast": [],
    "sensitive": ["--sensitive"],
    "very-sensitive": ["--very-sensitive"],
}


def diamond_available() -> bool:
    return shutil.which("diamond") is not None


def _index_genes(clusters: list[Cluster]) -> tuple[dict, dict]:
    """Return {gene_uid: Gene} and {gene_uid: cluster_index} for translated genes only."""
    genes: dict = {}
    gene_cluster: dict = {}
    for ci, cluster in enumerate(clusters):
        for locus in cluster.loci:
            for gene in locus.genes:
                if gene.translation:
                    genes[gene.uid] = gene
                    gene_cluster[gene.uid] = ci
    return genes, gene_cluster


def _write_fasta(genes: dict, path: Path) -> None:
    with path.open("w") as fh:
        for uid, gene in genes.items():
            fh.write(f">{uid}\n{gene.translation}\n")


def _run_diamond(genes, gene_cluster, identity_cutoff, evalue_cutoff, sensitivity) -> list[Link]:
    # Keep one (best-bitscore) undirected link per cross-cluster gene pair.
    best: dict = {}
    with tempfile.TemporaryDirectory(prefix="weft_diamond_") as tmp:
        tmp = Path(tmp)
        fasta, db, out = tmp / "proteins.fasta", tmp / "db.dmnd", tmp / "hits.tsv"
        _write_fasta(genes, fasta)

        subprocess.run(
            ["diamond", "makedb", "--in", str(fasta), "-d", str(db), "--quiet"],
            check=True,
        )
        subprocess.run(
            [
                "diamond", "blastp",
                "-q", str(fasta), "-d", str(db), "-o", str(out),
                "--outfmt", "6", *_OUTFMT,
                "--evalue", str(evalue_cutoff),
                "--max-target-seqs", "0",
                "--quiet",
                *_SENSITIVITY.get(sensitivity, []),
            ],
            check=True,
        )

        with out.open() as fh:
            for line in fh:
                q, s, pident, ppos, evalue, bitscore, qcov, scov = line.rstrip("\n").split("\t")
                if q == s or gene_cluster[q] == gene_cluster[s]:
                    continue  # self / intra-cluster hits are not comparison links
                identity = float(pident) / 100.0
                if identity < identity_cutoff:
                    continue
                bits = float(bitscore)
                key = frozenset((q, s))
                if key not in best or bits > best[key][2]:
                    best[key] = (
                        q,
                        s,
                        bits,
                        LinkMetrics(
                            identity=identity,
                            similarity=float(ppos) / 100.0,
                            coverage=min(float(qcov), float(scov)) / 100.0,
                            bitscore=bits,
                            evalue=float(evalue),
                        ),
                    )

    return [
        Link(uid=str(uuid.uuid4()), query=q, target=s, metrics=metrics)
        for (q, s, _bits, metrics) in best.values()
    ]


def _clamp01(x: float) -> float:
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def _aln_metrics(res, qlen: int, rlen: int):
    """Identity/similarity/coverage + aligned span (fractions, N→C) for one alignment.

    Identity and similarity are over the alignment length (columns incl. gaps),
    matching clinker. The span is the aligned sub-region on each protein: full
    length for a global alignment, the matched region for a local one. Returns
    ``None`` for an empty alignment.
    """
    tb = res.get_traceback()
    comp = tb.comp  # '|' identical, ':' positive substitution, ' ' gap/mismatch
    aln_len = len(comp)
    if aln_len == 0:
        return None
    identical = comp.count("|")
    positive = identical + comp.count(":")
    cig = res.get_cigar()
    qb, rb = cig.beg_query, cig.beg_ref
    qe, re = res.end_query, res.end_ref  # 0-based inclusive
    qspan, rspan = qe - qb + 1, re - rb + 1
    identity = identical / aln_len
    similarity = positive / aln_len
    coverage = min(qspan / qlen, rspan / rlen) if qlen and rlen else 0.0
    span = (qb / qlen, (qe + 1) / qlen, rb / rlen, (re + 1) / rlen)
    return identity, similarity, coverage, span


def _local_hsps(seq_a: str, seq_b: str, identity_cutoff: float):
    """Non-overlapping high-identity sub-regions (HSPs) between two proteins.

    Repeated Smith–Waterman with masking: align, record the region, mask the
    matched query residues (with '*', which scores strongly negative against every
    residue in BLOSUM62) so the next pass finds a different region. Bounded by
    _MAX_HSPS. Returns a list of (identity, similarity, coverage, span) tuples.
    """
    qlen, rlen = len(seq_a), len(seq_b)
    query = seq_a
    hsps = []
    for _ in range(_MAX_HSPS):
        res = parasail.sw_trace_scan_16(query, seq_b, _GAP_OPEN, _GAP_EXTEND, parasail.blosum62)
        if res.score <= 0:
            break
        m = _aln_metrics(res, qlen, rlen)
        if m is None:
            break
        identity, similarity, coverage, span = m
        cig = res.get_cigar()
        qb, qe = cig.beg_query, res.end_query
        # Stop at the first region that's too short or below the identity cutoff:
        # remaining regions can only score lower, so nothing better follows.
        if qe - qb + 1 < _MIN_HSP_AA or identity < identity_cutoff:
            break
        hsps.append((identity, similarity, coverage, span))
        query = query[:qb] + ("*" * (qe - qb + 1)) + query[qe + 1:]
    return hsps


def _run_parasail(genes, gene_cluster, identity_cutoff, mode, progress: Progress) -> list[Link]:
    if parasail is None:
        raise RuntimeError(
            "parasail not installed. Run through the pixi env (e.g. `pixi run dev`) "
            "so the parasail-python dependency is available."
        )
    if mode not in ("global", "local"):
        raise ValueError(f"Unknown parasail mode '{mode}' (expected 'global' or 'local')")

    # Deduplicate identical translations: align each unique sequence once, fan the
    # result out to every gene carrying it (SPEC §2.3).
    seq_to_uids: dict[str, list[str]] = {}
    for uid, gene in genes.items():
        seq_to_uids.setdefault(gene.translation, []).append(uid)
    reps = list(seq_to_uids.keys())

    if len(reps) > _MAX_PARASAIL_SEQS:
        raise RuntimeError(
            f"parasail engine handles up to {_MAX_PARASAIL_SEQS} unique proteins; "
            f"{len(reps)} present. Use the DIAMOND engine for inputs this large."
        )
    longest = max((len(s) for s in reps), default=0)
    if longest > _MAX_PARASAIL_LEN:
        raise RuntimeError(
            f"parasail engine caps protein length at {_MAX_PARASAIL_LEN} aa; "
            f"{longest} aa present. Use the DIAMOND engine."
        )

    rep_clusters = [{gene_cluster[u] for u in seq_to_uids[rep]} for rep in reps]

    best: dict = {}   # global mode: best link per gene pair
    links: list[Link] = []  # local mode: one link per HSP per gene pair

    def emit(qa: str, sb: str, identity, similarity, coverage, span):
        metrics = LinkMetrics(identity=identity, similarity=similarity, coverage=coverage)
        qs, qe, ts, te = span
        if mode == "global":
            key = frozenset((qa, sb))
            prev = best.get(key)
            if prev is None or identity > prev[2]:
                best[key] = (qa, sb, identity, metrics, span)
        else:
            links.append(Link(
                uid=str(uuid.uuid4()), query=qa, target=sb, metrics=metrics,
                query_start=_clamp01(qs), query_end=_clamp01(qe),
                target_start=_clamp01(ts), target_end=_clamp01(te),
            ))

    total = len(reps) * (len(reps) - 1) // 2
    done = 0
    for i in range(len(reps)):
        uids_i = seq_to_uids[reps[i]]
        # Identical protein shared across clusters → a perfect full-length link.
        if len(rep_clusters[i]) > 1:
            for a in range(len(uids_i)):
                for b in range(a + 1, len(uids_i)):
                    if gene_cluster[uids_i[a]] != gene_cluster[uids_i[b]]:
                        emit(uids_i[a], uids_i[b], 1.0, 1.0, 1.0, (0.0, 1.0, 0.0, 1.0))
        for j in range(i + 1, len(reps)):
            done += 1
            if progress and done % 200 == 0:
                progress(0.30 + 0.45 * done / max(total, 1), f"Aligning ({mode})")
            # Skip pairs with no cross-cluster gene combination (all in one cluster).
            if len(rep_clusters[i] | rep_clusters[j]) == 1:
                continue
            if mode == "global":
                res = parasail.nw_trace_scan_16(reps[i], reps[j], _GAP_OPEN, _GAP_EXTEND, parasail.blosum62)
                m = _aln_metrics(res, len(reps[i]), len(reps[j]))
                results = [m] if m and m[0] >= identity_cutoff else []
            else:
                results = _local_hsps(reps[i], reps[j], identity_cutoff)
            if not results:
                continue
            for ua in uids_i:
                for ub in seq_to_uids[reps[j]]:
                    if gene_cluster[ua] == gene_cluster[ub]:
                        continue
                    for (identity, similarity, coverage, span) in results:
                        emit(ua, ub, identity, similarity, coverage, span)

    if mode == "global":
        return [
            Link(
                uid=str(uuid.uuid4()), query=q, target=s, metrics=metrics,
                query_start=sp[0], query_end=sp[1], target_start=sp[2], target_end=sp[3],
            )
            for (q, s, _identity, metrics, sp) in best.values()
        ]
    return links


def compute_links(
    clusters: list[Cluster],
    engine: str = "diamond",
    identity_cutoff: float = 0.3,
    evalue_cutoff: float = 1e-3,
    sensitivity: str = "fast",
    mode: str = "global",
    progress: Progress = None,
) -> list[Link]:
    genes, gene_cluster = _index_genes(clusters)
    if len(genes) < 2:
        return []
    if engine == "diamond":
        if not diamond_available():
            raise RuntimeError(
                "DIAMOND binary not found on PATH. Run through the pixi env "
                "(e.g. `pixi run example` / `pixi run dev`) so the contained env is active."
            )
        return _run_diamond(genes, gene_cluster, identity_cutoff, evalue_cutoff, sensitivity)
    if engine == "parasail":
        return _run_parasail(genes, gene_cluster, identity_cutoff, mode, progress)
    raise ValueError(f"Unknown engine '{engine}' (expected one of {ENGINES})")
