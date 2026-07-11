"""Parse uploads into Cluster objects (SPEC §1). [MVP: GenBank + GFF3/FASTA]"""

from __future__ import annotations

import uuid
from pathlib import Path

from Bio import SeqIO
from Bio.Seq import Seq
from Bio.SeqFeature import SeqFeature

from app.core.models import Cluster, Gene, Locus

GBK_SUFFIXES = (".gbk", ".gb", ".genbank", ".gbf", ".gbff")
GFF_SUFFIXES = (".gff", ".gff3", ".gtf")
FASTA_SUFFIXES = (".fa", ".fna", ".fasta", ".fas", ".faa")

# Ordered preference for the gene display label (SPEC §1.3).
LABEL_QUALIFIERS = ("protein_id", "locus_tag", "gene", "ID", "product", "label", "name")

# Feature types that describe the record itself or merely duplicate CDS coordinates,
# so they are never rendered as individual genes.
NON_GENE_TYPES = frozenset({"source", "gene"})


def _flatten_qualifiers(qualifiers: dict) -> dict[str, str]:
    """Keep all qualifiers (except translation) as flat strings for later label switching."""
    out: dict[str, str] = {}
    for key, value in qualifiers.items():
        if key == "translation":
            continue
        if isinstance(value, (list, tuple)):
            out[key] = str(value[0]) if value else ""
        else:
            out[key] = str(value)
    return out


def _pick_label(names: dict[str, str], fallback: str) -> str:
    for key in LABEL_QUALIFIERS:
        if names.get(key):
            return names[key]
    return fallback


def _gene_from_feature(feature: SeqFeature, record, translate: bool = True) -> Gene:
    names = _flatten_qualifiers(feature.qualifiers)
    translation = feature.qualifiers.get("translation", [None])[0]
    if not translation and translate:
        try:
            translation = str(feature.extract(record.seq).translate(to_stop=True))
        except Exception:
            translation = ""
    uid = str(uuid.uuid4())
    location = feature.location
    return Gene(
        uid=uid,
        label=_pick_label(names, uid[:8]),
        names=names,
        start=int(location.start),
        end=int(location.end),
        strand=int(location.strand) if location.strand else 0,
        translation=translation or "",
    )


def parse_genbank(path: str, as_separate_clusters: bool = False) -> list[Cluster]:
    """Parse one GenBank file. One multi-locus cluster by default, or one per record."""
    path = Path(path)
    stem = path.stem
    loci: list[Locus] = []
    description: str | None = None

    for record in SeqIO.parse(str(path), "genbank"):
        cds = [f for f in record.features if f.type == "CDS"]
        if cds:
            # Standard case: CDS features are the genes, translated for homology.
            genes = [_gene_from_feature(f, record) for f in cds]
        else:
            # Annotation-only records (e.g. RGI/antiSMASH ARG/BGC feature tracks with
            # no CDS) would otherwise render empty. Fall back to every other located
            # feature so the file still draws. These aren't guaranteed single-frame
            # coding regions, so we don't synthesise translations for them; they render
            # as positioned, labelled features and simply don't take part in linking.
            genes = [
                _gene_from_feature(f, record, translate=False)
                for f in record.features
                if f.type not in NON_GENE_TYPES
            ]
        genes.sort(key=lambda g: g.start)
        loci.append(
            Locus(
                uid=str(uuid.uuid4()),
                name=record.name or record.id or stem,
                start=0,
                end=len(record.seq),
                genes=genes,
            )
        )
        if description is None:
            description = record.description

    metadata = {"description": description} if description else {}

    if as_separate_clusters:
        return [
            Cluster(uid=str(uuid.uuid4()), name=f"{stem} · {locus.name}", loci=[locus], metadata=metadata)
            for locus in loci
        ]
    return [Cluster(uid=str(uuid.uuid4()), name=stem, loci=loci, metadata=metadata)]


def _parse_attributes(raw: str) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for item in raw.split(";"):
        token = item.strip()
        if not token:
            continue
        if "=" in token:
            key, value = token.split("=", 1)
            attrs[key.strip()] = value.strip().strip('"')
            continue
        if " " in token:
            key, value = token.split(" ", 1)
            attrs[key.strip()] = value.strip().strip('"')
    return attrs


def _lookup_seq(seq_index: dict[str, Seq], seqid: str) -> Seq | None:
    if seqid in seq_index:
        return seq_index[seqid]
    short = seqid.split()[0]
    if short in seq_index:
        return seq_index[short]
    for key in seq_index:
        if key.split()[0] == short:
            return seq_index[key]
    return None


def parse_gff_with_fasta(path: str, fasta_path: str) -> list[Cluster]:
    """Parse one GFF/GTF file paired with nucleotide FASTA into a single cluster."""
    gff_path = Path(path)
    stem = gff_path.stem

    with Path(fasta_path).open() as fasta_fh:
        seq_index = {rec.id: rec.seq for rec in SeqIO.parse(fasta_fh, "fasta")}
    if not seq_index:
        raise ValueError(f"No sequences in FASTA: {fasta_path}")

    loci_by_seqid: dict[str, list[Gene]] = {}
    with gff_path.open() as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) != 9:
                continue
            seqid, _source, feature_type, start, end, _score, strand, _phase, attrs_raw = parts
            if feature_type != "CDS":
                continue

            names = _parse_attributes(attrs_raw)
            start_i, end_i = int(start), int(end)
            seq = _lookup_seq(seq_index, seqid)
            translation = names.get("translation", "")
            if not translation and seq is not None:
                try:
                    cds = seq[start_i - 1 : end_i]
                    if strand == "-":
                        cds = cds.reverse_complement()
                    translation = str(cds.translate(to_stop=True))
                except Exception:
                    translation = ""
            uid = str(uuid.uuid4())
            loci_by_seqid.setdefault(seqid, []).append(
                Gene(
                    uid=uid,
                    label=_pick_label(names, uid[:8]),
                    names={k: v for k, v in names.items() if k != "translation"},
                    start=start_i - 1,
                    end=end_i,
                    strand=-1 if strand == "-" else 1 if strand == "+" else 0,
                    translation=translation,
                )
            )

    loci: list[Locus] = []
    for seqid, genes in sorted(loci_by_seqid.items(), key=lambda item: item[0]):
        genes.sort(key=lambda g: g.start)
        seq = _lookup_seq(seq_index, seqid)
        loci.append(
            Locus(
                uid=str(uuid.uuid4()),
                name=seqid,
                start=0,
                end=len(seq) if seq is not None else max((g.end for g in genes), default=0),
                genes=genes,
            )
        )

    return [Cluster(uid=str(uuid.uuid4()), name=stem, loci=loci, metadata={"source": "gff"})]


def parse_files(paths: list[str], as_separate_clusters: bool = False) -> list[Cluster]:
    ppaths = [Path(p) for p in paths]
    clusters: list[Cluster] = []
    fasta_by_stem = {p.stem: str(p) for p in ppaths if p.suffix.lower() in FASTA_SUFFIXES}

    for path in ppaths:
        suffix = path.suffix.lower()
        if suffix in GBK_SUFFIXES:
            clusters.extend(parse_genbank(str(path), as_separate_clusters=as_separate_clusters))
            continue
        if suffix in GFF_SUFFIXES:
            fasta = fasta_by_stem.get(path.stem)
            if not fasta:
                raise ValueError(
                    f"Missing FASTA pair for {path.name}; expected one of "
                    f"{path.stem}.fa/.fna/.fasta"
                )
            clusters.extend(parse_gff_with_fasta(str(path), fasta))
            continue
        if suffix in FASTA_SUFFIXES:
            continue
        raise ValueError(
            f"Unsupported file type: {path} (supported: GenBank, GFF3/GTF + FASTA)"
        )
    return clusters
