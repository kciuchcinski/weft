import unittest

from app.core.models import Cluster, Gene, Locus
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
