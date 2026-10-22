import tempfile
import unittest
from pathlib import Path

from app.pipeline.parse import parse_files
from app.pipeline.run import _keep_files_together

# A CDS whose domain annotations arrive as repeated /note and /db_xref lines, the
# shape produced by PFAM/ECOD annotation pipelines.
MULTI_VALUE_GBK = """LOCUS       demo                      12 bp    DNA     linear   UNK 01-JAN-1980
DEFINITION  demo.
ACCESSION   demo
VERSION     demo
FEATURES             Location/Qualifiers
     CDS             1..12
                     /locus_tag="LT1"
                     /product="hypothetical protein"
                     /note="PFAM: PF00534 Glycos_transf_1"
                     /note="ECOD: e4xyzA1 P-loop domain"
                     /db_xref="Pfam:PF00534"
                     /db_xref="ECOD:1.1.1"
ORIGIN
        1 atggccattg ta
//
"""


class ParseGenbankTests(unittest.TestCase):
    def test_repeated_qualifiers_are_all_kept(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "demo.gbk"
            path.write_text(MULTI_VALUE_GBK)
            clusters = parse_files([str(path)])

        gene = clusters[0].loci[0].genes[0]
        # Both domain hits survive — keeping only the first hid ECOD entirely.
        self.assertIn("PF00534", gene.names["note"])
        self.assertIn("e4xyzA1", gene.names["note"])
        self.assertIn("Pfam:PF00534", gene.names["db_xref"])
        self.assertIn("ECOD:1.1.1", gene.names["db_xref"])
        # Single-valued qualifiers are unchanged (no stray separator).
        self.assertEqual(gene.names["product"], "hypothetical protein")

    def test_label_matches_qualifier_case_insensitively(self) -> None:
        gbk = MULTI_VALUE_GBK.replace('/locus_tag="LT1"', '/proteinID="HQ_PROTEIN_1"')
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "demo.gbk"
            path.write_text(gbk)
            clusters = parse_files([str(path)])

        gene = clusters[0].loci[0].genes[0]
        # /proteinID folds onto the protein_id preference rather than falling
        # through to the uuid fallback.
        self.assertEqual(gene.label, "HQ_PROTEIN_1")

    def test_sequence_qualifiers_are_not_annotations(self) -> None:
        gbk = MULTI_VALUE_GBK.replace('/locus_tag="LT1"', '/seq="ATGGCCATTGTA"')
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "demo.gbk"
            path.write_text(gbk)
            clusters = parse_files([str(path)])

        gene = clusters[0].loci[0].genes[0]
        # A raw nucleotide blob is not an annotation and would crowd out the real
        # ones in the tooltip.
        self.assertNotIn("seq", gene.names)
        self.assertIn("product", gene.names)


class SeparateRecordsTests(unittest.TestCase):
    def _write_two_record_files(self, root: Path) -> list[str]:
        two = MULTI_VALUE_GBK + MULTI_VALUE_GBK.replace("demo", "demo2")
        paths = [root / "draft.gbk", root / "genome.gbk"]
        for p in paths:
            p.write_text(two)
        return [str(p) for p in paths]

    def test_only_named_files_are_split(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            clusters = parse_files(self._write_two_record_files(Path(td)), separate_records=["draft.gbk"])

        # draft.gbk: one cluster per record, tagged with its file; genome.gbk stays one
        # cluster holding both records as loci.
        self.assertEqual([c.name for c in clusters], ["draft · demo", "draft · demo2", "genome"])
        self.assertEqual([len(c.loci) for c in clusters], [1, 1, 2])
        self.assertEqual(clusters[0].metadata["source_file"], "draft.gbk")
        self.assertNotIn("source_file", clusters[2].metadata)

    def test_split_records_stay_together_in_file_order(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            clusters = parse_files(self._write_two_record_files(Path(td)), separate_records=["draft.gbk"])
        a, b, genome = clusters
        # Synteny ordering placed the second contig first and the genome between them.
        self.assertEqual(_keep_files_together([b, genome, a], clusters), [a, b, genome])


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
