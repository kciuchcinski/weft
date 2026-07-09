import tempfile
import unittest
from pathlib import Path

from app.pipeline.parse import parse_files


class ParseGffTests(unittest.TestCase):
    def test_parses_gff_with_paired_fasta(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "sample.fasta").write_text(">ctg1\nATGGCCATTGTAATGGGCCGCTGAAAGGGTGCCCGATAG\n")
            (root / "sample.gff3").write_text(
                "##gff-version 3\n"
                "ctg1\tunit\tCDS\t1\t12\t.\t+\t0\tID=cds1;locus_tag=LT1;gene=foo\n"
            )

            clusters = parse_files([str(root / "sample.gff3"), str(root / "sample.fasta")])

        self.assertEqual(len(clusters), 1)
        self.assertEqual(clusters[0].name, "sample")
        self.assertEqual(len(clusters[0].loci), 1)
        self.assertEqual(clusters[0].loci[0].name, "ctg1")
        self.assertEqual(len(clusters[0].loci[0].genes), 1)
        gene = clusters[0].loci[0].genes[0]
        self.assertEqual(gene.label, "LT1")
        self.assertEqual(gene.start, 0)
        self.assertEqual(gene.end, 12)
        self.assertEqual(gene.strand, 1)
        self.assertTrue(gene.translation)

    def test_missing_fasta_pair_raises(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "sample.gff3").write_text(
                "##gff-version 3\n"
                "ctg1\tunit\tCDS\t1\t12\t.\t+\t0\tID=cds1\n"
            )
            with self.assertRaises(ValueError):
                parse_files([str(root / "sample.gff3")])


if __name__ == "__main__":
    unittest.main()
