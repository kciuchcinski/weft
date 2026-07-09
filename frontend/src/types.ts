// Mirror of the backend figure JSON contract (backend/app/core/models.py, SPEC §0).

export type MetricKey =
  | "identity"
  | "similarity"
  | "coverage"
  | "bitscore"
  | "evalue"
  | "jaccard";

export interface Gene {
  uid: string;
  label: string;
  names: Record<string, string>;
  start: number;
  end: number;
  strand: number;
  translation?: string;
}

export interface Locus {
  uid: string;
  name: string;
  start: number;
  end: number;
  genes: Gene[];
}

export interface Cluster {
  uid: string;
  name: string;
  loci: Locus[];
  metadata?: Record<string, string>;
  reversed?: boolean;
}

export interface LinkMetrics {
  identity?: number;
  similarity?: number;
  coverage?: number;
  bitscore?: number;
  evalue?: number;
  jaccard?: number;
}

export interface Link {
  uid: string;
  query: string;
  target: string;
  metrics: LinkMetrics;
  // Aligned sub-region on each protein as fractions [0,1] of protein length,
  // N→C terminus. Present for local (partial-similarity) alignments so the ribbon
  // anchors to just the matched region; absent for whole-gene links.
  query_start?: number;
  query_end?: number;
  target_start?: number;
  target_end?: number;
}

export interface Group {
  uid: string;
  label: string;
  genes: string[];
  colour?: string | null;
  hidden?: boolean;
}

export interface FigureData {
  schemaVersion: number;
  clusters: Cluster[];
  links: Link[];
  groups: Group[];
}
