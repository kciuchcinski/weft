"""Order clusters by synteny via hierarchical clustering (SPEC §4). [MVP]"""

from __future__ import annotations

import numpy as np
from scipy.cluster import hierarchy
from scipy.spatial.distance import squareform

from app.core.models import Cluster, Group, Link


def _gene_to_group(groups: list[Group]) -> dict[str, int]:
    mapping: dict[str, int] = {}
    for gi, group in enumerate(groups):
        for uid in group.genes:
            mapping[uid] = gi
    return mapping


def _group_sequence(cluster: Cluster, gene_group: dict[str, int]) -> list[int]:
    seq: list[int] = []
    for locus in cluster.loci:
        for gene in locus.genes:
            gid = gene_group.get(gene.uid)
            if gid is not None:
                seq.append(gid)
    return seq


def _synteny(seq_a: list[int], seq_b: list[int], weight: float) -> float:
    """S = shared similarity groups + weight * shared (unordered) adjacent group pairs."""
    shared = len(set(seq_a) & set(seq_b))
    adj_a = {frozenset((seq_a[i], seq_a[i + 1])) for i in range(len(seq_a) - 1)}
    adj_b = {frozenset((seq_b[i], seq_b[i + 1])) for i in range(len(seq_b) - 1)}
    contiguity = len(adj_a & adj_b)
    return shared + weight * contiguity


def order_clusters(
    clusters: list[Cluster],
    links: list[Link],
    groups: list[Group],
    method: str = "ward",
    weight: float = 0.5,
) -> list[int]:
    """Return cluster display order (indices into `clusters`)."""
    n = len(clusters)
    if n <= 2 or not groups:
        return list(range(n))

    gene_group = _gene_to_group(groups)
    seqs = [_group_sequence(c, gene_group) for c in clusters]

    score = np.zeros((n, n))
    for i in range(n):
        for j in range(i + 1, n):
            score[i, j] = score[j, i] = _synteny(seqs[i], seqs[j], weight)

    if score.max() == 0:
        return list(range(n))

    distance = score.max() - score
    np.fill_diagonal(distance, 0.0)
    linkage = hierarchy.linkage(squareform(distance, checks=False), method=method)
    return [int(i) for i in hierarchy.leaves_list(linkage)]
