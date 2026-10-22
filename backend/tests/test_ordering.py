import unittest

from app.core.models import Cluster, Gene, Group, Locus
from app.pipeline.ordering import _synteny, order_clusters


def _cluster(cid: str, group_ids: list[int]) -> Cluster:
    """A one-locus cluster whose i-th gene belongs to similarity group group_ids[i]."""
    genes = [
        Gene(uid=f"{cid}g{i}", label=f"{cid}g{i}", start=i * 100, end=i * 100 + 90, strand=1)
        for i in range(len(group_ids))
    ]
    return Cluster(uid=cid, name=cid, loci=[Locus(uid=f"l{cid}", name=f"l{cid}", start=0, end=9999, genes=genes)])


def _groups(clusters: list[Cluster], layout: dict[str, list[int]]) -> list[Group]:
    """Build Group objects from the per-cluster group-id layout used by _cluster."""
    members: dict[int, list[str]] = {}
    for c in clusters:
        for gene, gid in zip(c.loci[0].genes, layout[c.uid]):
            members.setdefault(gid, []).append(gene.uid)
    return [Group(uid=f"G{gid}", label=f"Group {gid}", genes=uids) for gid, uids in sorted(members.items())]


def _adjacent(order: list[int], a: int, b: int) -> bool:
    return abs(order.index(a) - order.index(b)) == 1


class SyntenyScoreTests(unittest.TestCase):
    def test_counts_shared_groups_plus_weighted_shared_adjacencies(self) -> None:
        # Shared groups {1, 2}; shared adjacency {1, 2} (order-insensitive).
        self.assertEqual(_synteny([0, 1, 2], [2, 1, 3], weight=0.5), 2.5)

    def test_no_overlap_scores_zero(self) -> None:
        self.assertEqual(_synteny([0, 1], [2, 3], weight=0.5), 0.0)

    def test_shared_groups_without_shared_adjacency(self) -> None:
        self.assertEqual(_synteny([0, 1, 2], [0, 3, 2], weight=0.5), 2.0)


class OrderClustersTests(unittest.TestCase):
    def test_two_or_fewer_clusters_keep_input_order(self) -> None:
        layout = {"A": [0, 1], "B": [0, 1]}
        clusters = [_cluster(cid, gids) for cid, gids in layout.items()]
        self.assertEqual(order_clusters(clusters, [], _groups(clusters, layout)), [0, 1])

    def test_no_groups_keeps_input_order(self) -> None:
        clusters = [_cluster(cid, [0, 1]) for cid in "ABC"]
        self.assertEqual(order_clusters(clusters, [], []), [0, 1, 2])

    def test_no_shared_groups_keeps_input_order(self) -> None:
        layout = {"A": [0, 1], "B": [2, 3], "C": [4, 5]}
        clusters = [_cluster(cid, gids) for cid, gids in layout.items()]
        self.assertEqual(order_clusters(clusters, [], _groups(clusters, layout)), [0, 1, 2])

    def test_syntenic_clusters_end_up_adjacent(self) -> None:
        # Interleaved input: A~C share one gene family block, B~D another.
        layout = {"A": [0, 1, 2, 3], "B": [4, 5, 6, 7], "C": [0, 1, 2, 3], "D": [4, 5, 6, 7]}
        clusters = [_cluster(cid, gids) for cid, gids in layout.items()]
        order = order_clusters(clusters, [], _groups(clusters, layout))

        self.assertEqual(sorted(order), [0, 1, 2, 3])
        self.assertTrue(_adjacent(order, 0, 2))
        self.assertTrue(_adjacent(order, 1, 3))

    def test_gene_order_breaks_ties_between_equal_content(self) -> None:
        # B and C share all of A's groups, but only B keeps A's gene order.
        layout = {"A": [0, 1, 2, 3], "X": [9], "C": [3, 1, 0, 2], "B": [0, 1, 2, 3]}
        clusters = [_cluster(cid, gids) for cid, gids in layout.items()]
        order = order_clusters(clusters, [], _groups(clusters, layout))
        self.assertTrue(_adjacent(order, 0, 3))

    def test_order_is_deterministic(self) -> None:
        layout = {"A": [0, 1, 2], "B": [3, 4], "C": [0, 2, 1], "D": [3, 4, 5], "E": [0, 1]}
        clusters = [_cluster(cid, gids) for cid, gids in layout.items()]
        groups = _groups(clusters, layout)
        first = order_clusters(clusters, [], groups)
        for _ in range(5):
            self.assertEqual(order_clusters(clusters, [], groups), first)


if __name__ == "__main__":
    unittest.main()
