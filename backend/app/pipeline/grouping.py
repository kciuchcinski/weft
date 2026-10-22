"""Group genes into similarity groups from links, via a disjoint-set.

Single-linkage at a metric threshold: two genes share a group when a chain of
above-threshold links joins them. This is a similarity grouping, not homology
inference.
"""

from __future__ import annotations

import uuid

from app.core.models import Group, Link


class _DisjointSet:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, x: str) -> str:
        self.parent.setdefault(x, x)
        root = x
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[x] != root:  # path compression
            self.parent[x], x = root, self.parent[x]
        return root

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def build_groups(
    links: list[Link],
    threshold: float = 0.3,
    metric: str = "identity",
    min_size: int = 2,
) -> list[Group]:
    """Connected components of the gene graph (links above `threshold` on `metric`).

    Groups smaller than `min_size` (singletons) are omitted; the frontend renders
    ungrouped genes greyed out.
    """
    ds = _DisjointSet()
    for link in links:
        value = getattr(link.metrics, metric, None)
        if value is None or value < threshold:
            continue
        ds.union(link.query, link.target)

    components: dict[str, set[str]] = {}
    for gene_uid in list(ds.parent.keys()):
        components.setdefault(ds.find(gene_uid), set()).add(gene_uid)

    groups: list[Group] = []
    for idx, members in enumerate(sorted(components.values(), key=len, reverse=True), start=1):
        if len(members) < min_size:
            continue
        groups.append(
            Group(uid=str(uuid.uuid4()), label=f"Group {idx}", genes=sorted(members))
        )
    return groups
