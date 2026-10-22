import random
import unittest
from pathlib import Path

from app.core.models import Cluster, Gene, Locus
from app.pipeline.run import run_pipeline
from app.pipeline.similarity import compute_links

try:
    import parasail  # noqa: F401

    HAVE_PARASAIL = True
except ImportError:
    HAVE_PARASAIL = False


def _cluster(cid: str, uid: str, translation: str) -> Cluster:
    gene = Gene(uid=uid, label=uid, start=0, end=len(translation) * 3, strand=1, translation=translation)
    return Cluster(uid=cid, name=cid, loci=[Locus(uid="l" + cid, name="l" + cid, start=0, end=9999, genes=[gene])])


# 33-residue conserved core flanked by divergent 16-residue tails, so the shared
# region is ~the middle 50% of each protein.
_CORE = "WWWWWQHKMLARNDTGYFPVSAEIWQHKMLARND"
_FLANK_A = "AAAAAAAAAAAAAAAA"
_FLANK_B = "GGGGGGGGGGGGGGGG"
_SEQ_A = _FLANK_A + _CORE + _FLANK_A
_SEQ_B = _FLANK_B + _CORE + _FLANK_B

_AMINO = "ACDEFGHIKLMNPQRSTVWY"
_TEST_DATA = Path(__file__).resolve().parents[2] / "test_data"


def _random_protein(rng: random.Random, length: int) -> str:
    return "".join(rng.choice(_AMINO) for _ in range(length))


@unittest.skipUnless(HAVE_PARASAIL, "parasail not installed")
class ParasailEngineTests(unittest.TestCase):
    def test_local_mode_reports_partial_region(self) -> None:
        clusters = [_cluster("c1", "gA", _SEQ_A), _cluster("c2", "gB", _SEQ_B)]
        links = compute_links(clusters, engine="parasail", mode="local", identity_cutoff=0.3)

        self.assertEqual(len(links), 1)
        link = links[0]
        # Perfect identity over roughly half the protein.
        self.assertGreater(link.metrics.identity, 0.95)
        self.assertLess(link.metrics.coverage, 0.7)
        self.assertGreater(link.metrics.coverage, 0.3)
        # Aligned span sits in the middle of each protein.
        for start, end in ((link.query_start, link.query_end), (link.target_start, link.target_end)):
            self.assertIsNotNone(start)
            self.assertIsNotNone(end)
            self.assertGreater(start, 0.1)
            self.assertLess(end, 0.9)
            self.assertAlmostEqual(start, 0.24, delta=0.06)
            self.assertAlmostEqual(end, 0.76, delta=0.06)

    def test_local_mode_ignores_unrelated_proteins(self) -> None:
        # Unrelated proteins share only short chance matches, which aren't significant.
        # (This seed gives a 30%+-identity SW hit with E ≈ 0.02 that used to pass.)
        rng = random.Random(0)
        clusters = [
            _cluster("c1", "gA", _random_protein(rng, 300)),
            _cluster("c2", "gB", _random_protein(rng, 300)),
        ]
        links = compute_links(clusters, engine="parasail", mode="local", identity_cutoff=0.3)
        self.assertEqual(links, [])

    @unittest.skipUnless(_TEST_DATA.is_dir(), "test_data not present")
    def test_local_mode_groups_match_global_on_test_data(self) -> None:
        # Local mode may add a few partial links but must not chain chance matches
        # into extra merges: grouping should match global mode.
        paths = sorted(str(p) for p in _TEST_DATA.glob("*.gbk"))
        global_fd = run_pipeline(paths, engine="parasail", mode="global")
        local_fd = run_pipeline(paths, engine="parasail", mode="local")
        self.assertEqual(len(local_fd.groups), len(global_fd.groups))
        self.assertGreaterEqual(len(local_fd.links), len(global_fd.links))
        self.assertLessEqual(len(local_fd.links), len(global_fd.links) + 10)

    def test_global_mode_spans_full_length(self) -> None:
        clusters = [_cluster("c1", "gA", _SEQ_A), _cluster("c2", "gB", _SEQ_B)]
        links = compute_links(clusters, engine="parasail", mode="global", identity_cutoff=0.3)

        self.assertEqual(len(links), 1)
        link = links[0]
        # Global identity is diluted by the divergent flanks; span is full-length.
        self.assertLess(link.metrics.identity, 0.7)
        self.assertAlmostEqual(link.query_start, 0.0, delta=0.02)
        self.assertAlmostEqual(link.query_end, 1.0, delta=0.02)
        self.assertAlmostEqual(link.target_start, 0.0, delta=0.02)
        self.assertAlmostEqual(link.target_end, 1.0, delta=0.02)

    def test_dedup_fans_out_identical_protein(self) -> None:
        # Same protein in three clusters → one link per cross-cluster pair (3).
        clusters = [
            _cluster("c1", "g1", _CORE),
            _cluster("c2", "g2", _CORE),
            _cluster("c3", "g3", _CORE),
        ]
        links = compute_links(clusters, engine="parasail", mode="global", identity_cutoff=0.3)
        self.assertEqual(len(links), 3)
        self.assertTrue(all(l.metrics.identity == 1.0 for l in links))
        pairs = {frozenset((l.query, l.target)) for l in links}
        self.assertEqual(len(pairs), 3)

    def test_unknown_engine_raises(self) -> None:
        clusters = [_cluster("c1", "gA", _SEQ_A), _cluster("c2", "gB", _SEQ_B)]
        with self.assertRaises(ValueError):
            compute_links(clusters, engine="bogus")


if __name__ == "__main__":
    unittest.main()
