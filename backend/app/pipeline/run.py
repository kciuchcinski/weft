"""Pipeline orchestrator: parse → similarity → grouping → ordering → FigureData."""

from __future__ import annotations

from collections.abc import Collection
from typing import Callable, Optional

from app.config import settings
from app.core.models import Cluster, FigureData
from app.pipeline.grouping import build_groups
from app.pipeline.ordering import order_clusters
from app.pipeline.parse import parse_files
from app.pipeline.similarity import compute_links

Progress = Optional[Callable[[float, str], None]]


class InputTooLarge(Exception):
    """Raised when parsed input exceeds a configured resource guard.

    The message is surfaced verbatim to the client via the job ``error`` field,
    so it must read as a clear, actionable limit explanation.
    """


def enforce_limits(clusters: list[Cluster]) -> None:
    """Reject oversized input before the expensive alignment step runs.

    Guards are conservative for an open, hosted beta where uploads are
    uncontrolled and the default engine (parasail) is exact O(N²) pairwise.
    """
    if len(clusters) > settings.max_clusters:
        raise InputTooLarge(
            f"{len(clusters)} clusters exceeds the limit of {settings.max_clusters}. "
            "Upload fewer files or split the job."
        )

    gene_count = 0
    longest = 0
    for c in clusters:
        for locus in c.loci:
            for g in locus.genes:
                gene_count += 1
                longest = max(longest, len(g.translation))
    if gene_count > settings.max_total_genes:
        raise InputTooLarge(
            f"{gene_count} genes exceeds the limit of {settings.max_total_genes}. "
            "Reduce the number or size of input clusters."
        )
    if longest > settings.max_sequence_length:
        raise InputTooLarge(
            f"A sequence of {longest} residues exceeds the per-sequence limit of "
            f"{settings.max_sequence_length}."
        )


def _keep_files_together(ordered: list[Cluster], parsed: list[Cluster]) -> list[Cluster]:
    """Gather the records of each split file at its first member's position, in file
    order. Synteny ordering would otherwise scatter a draft assembly's contigs."""
    by_file: dict[str, list[Cluster]] = {}
    for c in parsed:
        if "source_file" in c.metadata:
            by_file.setdefault(c.metadata["source_file"], []).append(c)
    out: list[Cluster] = []
    emitted: set[str] = set()
    for c in ordered:
        source = c.metadata.get("source_file")
        if source is None:
            out.append(c)
        elif source not in emitted:
            emitted.add(source)
            out.extend(by_file[source])
    return out


def run_pipeline(
    paths: list[str],
    engine: str = "parasail",
    mode: str = "global",
    identity_cutoff: float = 0.3,
    evalue_cutoff: float = 1e-3,
    as_separate_clusters: bool = False,
    separate_records: Collection[str] = (),
    progress: Progress = None,
) -> FigureData:
    def report(fraction: float, message: str) -> None:
        if progress:
            progress(fraction, message)

    report(0.05, "Parsing input files")
    clusters = parse_files(
        paths, as_separate_clusters=as_separate_clusters, separate_records=separate_records
    )
    enforce_limits(clusters)

    gene_count = sum(len(locus.genes) for c in clusters for locus in c.loci)
    report(0.30, f"Aligning {gene_count} genes ({engine})")
    links = compute_links(
        clusters,
        engine=engine,
        mode=mode,
        identity_cutoff=identity_cutoff,
        evalue_cutoff=evalue_cutoff,
        progress=progress,
    )

    report(0.75, "Building similarity groups")
    groups = build_groups(links, threshold=identity_cutoff)

    report(0.90, "Ordering clusters")
    order = order_clusters(clusters, links, groups)
    ordered = _keep_files_together([clusters[i] for i in order], clusters)

    report(1.0, "Done")
    return FigureData(
        schemaVersion=1,
        clusters=ordered,
        links=links,
        groups=groups,
    )
