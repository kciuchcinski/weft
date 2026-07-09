"""Generate the bundled example figure + curated session for the frontend.

Run with:  pixi run example

Steps:
  1. prep_example — trim the raw phage sources into test_data/ (intact phage1,
     three phage1 tiles, trimmed phage2).
  2. run the real pipeline (parse → DIAMOND → group → order) → figure JSON.
  3. write sample_data.json (raw figure) and example_session.json (figure + a
     curated view: three lanes with the phage1 tiles packed on one row, coloured
     by pharokka's PHROG "function" field). The frontend's "Load example dataset"
     button loads example_session.json directly.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from app import prep_example
from app.config import settings
from app.pipeline.run import run_pipeline

# Nicer on-figure names than the raw file stems, keyed by cluster name (= stem).
DISPLAY_NAMES = {
    "phage1": "phage 1 (intact)",
    "phage1_part1": "phage 1 · tile 1",
    "phage1_part2": "phage 1 · tile 2",
    "phage1_part3": "phage 1 · tile 3",
    "phage2": "phage 2",
}

# Three rows: intact phage1 on top, its three tiles packed on the middle row
# (the "more than one entry per line" showcase), phage2 on the bottom. Ribbons
# draw only between adjacent rows, giving phage1↔tiles and tiles↔phage2.
LANE_STEMS = [
    ["phage1"],
    ["phage1_part1", "phage1_part2", "phage1_part3"],
    ["phage2"],
]

# phage2's shared block sits on the opposite strand; flip it so it reads in the
# same orientation as the phage1 rows above it.
REVERSED_STEMS = {"phage2"}


def build_session(payload: dict) -> dict:
    """Wrap a figure payload in a curated Session (matches frontend store shape)."""
    stem_to_uid = {c["name"]: c["uid"] for c in payload["clusters"]}

    for cluster in payload["clusters"]:
        stem = cluster["name"]
        cluster["name"] = DISPLAY_NAMES.get(stem, stem)
        if stem in REVERSED_STEMS:
            cluster["reversed"] = True

    lanes = [[stem_to_uid[s] for s in lane if s in stem_to_uid] for lane in LANE_STEMS]
    lanes = [lane for lane in lanes if lane]

    return {
        "schemaVersion": 1,
        "data": payload,
        "view": {
            "lanes": lanes,
            "clusterOffsets": {},
            "activeMetric": "identity",
            "colourBy": "field",
            "colourField": "function",
            "paletteName": "Tableau 10",
            "overrides": {},
            "customGroups": [],
            "activeCustomGroup": None,
            # style omitted → frontend loadSession falls back to DEFAULT_STYLE.
        },
    }


def main() -> None:
    prep_example.main()

    data_dir = settings.example_dir
    paths = sorted(str(p) for p in Path(data_dir).glob("*.gbk"))
    if not paths:
        print(f"No .gbk files found in {data_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"Running pipeline on {len(paths)} clusters from {data_dir}")
    for p in paths:
        print(f"  · {Path(p).name}")

    def progress(fraction: float, message: str) -> None:
        print(f"  [{fraction * 100:5.1f}%] {message}")

    figure = run_pipeline(paths, engine="diamond", progress=progress)
    payload = figure.model_dump()

    public = settings.repo_root / "frontend" / "public"
    (Path(__file__).resolve().parent.parent / "sample_data.json").write_text(
        json.dumps(payload, indent=2)
    )
    (public / "sample_data.json").write_text(json.dumps(payload, indent=2))

    session = build_session(payload)
    (public / "example_session.json").write_text(json.dumps(session, indent=2))
    print(f"Wrote {public / 'example_session.json'}")

    print(
        f"Result: clusters={len(payload['clusters'])} "
        f"links={len(payload['links'])} groups={len(payload['groups'])} "
        f"lanes={len(session['view']['lanes'])}"
    )


if __name__ == "__main__":
    main()
