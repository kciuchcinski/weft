import unittest

from app.core.models import Link, LinkMetrics
from app.pipeline.grouping import build_groups


def _link(query: str, target: str, **metrics: float) -> Link:
    return Link(uid=f"{query}-{target}", query=query, target=target, metrics=LinkMetrics(**metrics))


def _members(groups) -> list[list[str]]:
    return [g.genes for g in groups]


class BuildGroupsTests(unittest.TestCase):
    def test_no_links_gives_no_groups(self) -> None:
        self.assertEqual(build_groups([]), [])

    def test_single_linkage_is_transitive(self) -> None:
        # a–c are never linked directly; the chain through b still joins them.
        links = [_link("a", "b", identity=0.9), _link("b", "c", identity=0.4)]
        self.assertEqual(_members(build_groups(links, threshold=0.3)), [["a", "b", "c"]])

    def test_links_below_threshold_are_ignored(self) -> None:
        links = [_link("a", "b", identity=0.5), _link("c", "d", identity=0.2)]
        self.assertEqual(_members(build_groups(links, threshold=0.3)), [["a", "b"]])

    def test_threshold_is_inclusive(self) -> None:
        links = [_link("a", "b", identity=0.3)]
        self.assertEqual(_members(build_groups(links, threshold=0.3)), [["a", "b"]])

    def test_weak_bridge_splits_when_threshold_rises(self) -> None:
        links = [
            _link("a", "b", identity=0.9),
            _link("b", "c", identity=0.4),  # the only bridge between the two pairs
            _link("c", "d", identity=0.8),
        ]
        self.assertEqual(_members(build_groups(links, threshold=0.3)), [["a", "b", "c", "d"]])
        self.assertEqual(
            sorted(_members(build_groups(links, threshold=0.5))), [["a", "b"], ["c", "d"]]
        )

    def test_metric_selects_which_value_is_thresholded(self) -> None:
        # DIAMOND-style link with only similarity populated; identity is missing.
        links = [_link("a", "b", similarity=0.9)]
        self.assertEqual(build_groups(links, metric="identity"), [])
        self.assertEqual(_members(build_groups(links, metric="similarity")), [["a", "b"]])

    def test_groups_are_ordered_largest_first_with_sequential_labels(self) -> None:
        links = [
            _link("x", "y", identity=0.9),
            _link("a", "b", identity=0.9),
            _link("b", "c", identity=0.9),
        ]
        groups = build_groups(links)
        self.assertEqual(_members(groups), [["a", "b", "c"], ["x", "y"]])
        self.assertEqual([g.label for g in groups], ["Group 1", "Group 2"])
        self.assertEqual(len({g.uid for g in groups}), 2)

    def test_min_size_drops_small_groups(self) -> None:
        links = [
            _link("a", "a", identity=1.0),  # self-hit → singleton
            _link("x", "y", identity=0.9),
            _link("p", "q", identity=0.9),
            _link("q", "r", identity=0.9),
        ]
        self.assertEqual(sorted(_members(build_groups(links))), [["p", "q", "r"], ["x", "y"]])
        self.assertEqual(_members(build_groups(links, min_size=3)), [["p", "q", "r"]])

    def test_result_is_independent_of_link_direction(self) -> None:
        forward = [_link("a", "b", identity=0.9), _link("b", "c", identity=0.9)]
        reverse = [_link("c", "b", identity=0.9), _link("b", "a", identity=0.9)]
        self.assertEqual(_members(build_groups(forward)), _members(build_groups(reverse)))


if __name__ == "__main__":
    unittest.main()
