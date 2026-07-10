"""Prepare the bundled phage example inputs (test_data/) from the raw sources.

phage1 and phage2 (in backend/example_src/) share a virion structural /
morphogenesis module. This script trims both to that block plus a little
context, and additionally emits phage1 as three consecutive tiles so the
figure can show the same cluster both intact and split across one row
(Weft's "more than one entry per line").

Pharokka's PHROG annotations (/product, /function, /phrog, /locus_tag) are
preserved untouched — no enrichment. Run via ``pixi run example`` (build_example
calls this first) or directly with ``python -m app.prep_example``.
"""

from __future__ import annotations

from pathlib import Path

from Bio import SeqIO
from Bio.SeqRecord import SeqRecord

from app.config import settings

SRC_DIR = settings.repo_root / "backend" / "example_src"
OUT_DIR = settings.example_dir

# Trim windows are 0-based half-open slice indices into the source sequence.
# Boundaries were chosen to sit in intergenic gaps so no CDS is bisected
# (BioPython drops any feature not fully contained in a slice).
PHAGE2_WINDOW = (1900, 22500)  # tail fiber … portal + terminase context (complement)
PHAGE1_WINDOW = (27000, 51000)  # portal … tail fiber + flanking context

# Split points inside PHAGE1_WINDOW, each landing in a real intergenic gap:
#   36550 → gap after tail terminator (…36466) before minor tail (36646…)
#   42450 → gap after tape measure (…42406) before next hypothetical (42490…)
PHAGE1_TILES = [
    ("phage1_part1", 27000, 36550),
    ("phage1_part2", 36550, 42450),
    ("phage1_part3", 42450, 51000),
]


def _slice(record: SeqRecord, start: int, end: int, name: str) -> SeqRecord:
    """Slice a record to [start, end) and restore the metadata GenBank output needs."""
    sub = record[start:end]
    sub.id = name
    sub.name = name
    sub.description = f"{record.id} {start + 1}-{end} ({end - start} bp)"
    # Slicing drops top-level annotations; SeqIO's GenBank writer requires
    # molecule_type, and topology reads nicer as linear for a trimmed region.
    sub.annotations["molecule_type"] = record.annotations.get("molecule_type", "DNA")
    sub.annotations["topology"] = "linear"
    return sub


def _cds_count(record: SeqRecord) -> int:
    return sum(1 for f in record.features if f.type == "CDS")


def _write(record: SeqRecord, name: str) -> None:
    out = OUT_DIR / f"{name}.gbk"
    SeqIO.write(record, out, "genbank")
    print(f"  wrote {out.name}: {len(record.seq)} bp, {_cds_count(record)} CDS")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    phage1 = next(SeqIO.parse(str(SRC_DIR / "phage1.gbk"), "genbank"))
    phage2 = next(SeqIO.parse(str(SRC_DIR / "phage2.gbk"), "genbank"))

    print("Preparing example inputs in", OUT_DIR)

    # phage2: single trimmed cluster covering the shared block + context.
    _write(_slice(phage2, *PHAGE2_WINDOW, "phage2"), "phage2")

    # phage1: intact trimmed cluster, plus the same window split into tiles.
    _write(_slice(phage1, *PHAGE1_WINDOW, "phage1"), "phage1")
    for name, start, end in PHAGE1_TILES:
        _write(_slice(phage1, start, end, name), name)


if __name__ == "__main__":
    main()
