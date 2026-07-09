"""Serialisable domain model — the figure JSON contract (SPEC §0, §2.4, §12)."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class Gene(BaseModel):
    uid: str
    label: str
    names: dict[str, str] = {}
    start: int
    end: int
    strand: int
    translation: str = ""


class Locus(BaseModel):
    uid: str
    name: str
    start: int
    end: int
    genes: list[Gene] = []


class Cluster(BaseModel):
    uid: str
    name: str
    loci: list[Locus] = []
    metadata: dict[str, str] = {}


class LinkMetrics(BaseModel):
    """Full metric bundle per link; the UI picks the active one live (SPEC §2.4)."""

    identity: Optional[float] = None
    similarity: Optional[float] = None
    coverage: Optional[float] = None
    bitscore: Optional[float] = None
    evalue: Optional[float] = None
    jaccard: Optional[float] = None


class Link(BaseModel):
    uid: str
    query: str  # gene uid
    target: str  # gene uid
    metrics: LinkMetrics
    # Aligned sub-region on each protein, as fractions [0,1] of protein length
    # measured N→C terminus. Present for local (partial-similarity) alignments so
    # the figure can anchor the ribbon to just the matched region; None for
    # whole-gene links (DIAMOND, global alignment) which span the full protein.
    query_start: Optional[float] = None
    query_end: Optional[float] = None
    target_start: Optional[float] = None
    target_end: Optional[float] = None


class Group(BaseModel):
    uid: str
    label: str
    genes: list[str] = []  # gene uids
    colour: Optional[str] = None
    hidden: bool = False


class FigureData(BaseModel):
    schemaVersion: int = 1
    clusters: list[Cluster] = []
    links: list[Link] = []
    groups: list[Group] = []


class JobRequest(BaseModel):
    upload_token: Optional[str] = None
    example: Optional[str] = None  # run on a bundled example set (e.g. "test_data")
    engine: str = "parasail"  # parasail | diamond (diamond needs the binary on PATH)
    mode: str = "global"  # global | local — only consumed by the parasail engine
    scope: str = "all-vs-all"  # all-vs-all | adjacent
    identity_cutoff: float = 0.3
    evalue_cutoff: float = 1e-3


class ParseRequest(BaseModel):
    upload_token: Optional[str] = None
    example: Optional[str] = None
    as_separate_clusters: bool = False


class ParseReport(BaseModel):
    files: list[str] = []
    warnings: list[str] = []
    errors: list[str] = []
