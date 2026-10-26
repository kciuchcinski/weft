#!/usr/bin/env python3
"""Runtime table for the Weft API: four input sizes × global / local / DIAMOND.

Sizes are defined in CDS, the unit of Weft's limits. Every input is k clusters of
n CDS: the first n CDS of each of the first k genomes in PANEL, a fixed set of
T4-like phages (Tevenvirinae, NCBI RefSeq) taken round-robin across 14 genera.
Runtime follows (protein pairs between clusters) × (protein length)², so the
table also reports total and mean protein length.

Each timed run is one complete job: from POST /api/jobs until the job reports
"succeeded" (parse, align, group, order, result download), polled every 10 ms.
The upload happens before the clock starts.

    # server, with the 300 s job limit off:
    cd backend && JOB_TIMEOUT_SECONDS=0 pixi run uvicorn app.main:app --port 8000
    # client, on the same machine (Biopython from the pixi env cuts the inputs):
    cd backend && pixi run python ../bench/runtime.py [--runs 5] [--label ...] [--note "..."]

Genomes are downloaded once into bench/data/. Results go to
bench/results/<label>.json (raw times + hardware) and <label>.md.
`python3 bench/runtime.py --table` merges every results/*.json into one table,
e.g. after copying in the run from another machine.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import socket
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
RESULTS = HERE / "results"

PANEL = [
    "NC_000866.4",  # T4 (Tequatrovirus)
    "NC_004928.1",  # RB69 (Mosigvirus)
    "NC_010105.1",  # JS98 (Dhakavirus)
    "NC_014595.1",  # Shigella phage SP18 (Gaprivervirus)
    "NC_028686.1",  # Klebsiella phage JD18 (Jiaodavirus)
    "NC_020416.1",  # Salmonella phage S16 (Gelderlandvirus)
    "NC_048849.1",  # Enterobacter phage vB_EclM_CIP9 (Kanagawavirus)
    "NC_027331.1",  # Citrobacter phage Moon (Moonvirus)
    "NC_014662.1",  # CC31 (Karamvirus)
    "NC_019909.1",  # Yersinia phage phiR1-RT (Tegunavirus)
    "NC_041996.1",  # Serratia phage CHI14 (Winklervirus)
    "NC_015250.1",  # Acinetobacter phage 133 (Centumtrigintavirus)
    "NC_028940.1",  # Pectobacterium phage PM2 (Mosugukvirus)
    "NC_055743.1",  # Erwinia phage Cronus (Risoevirus)
    "NC_008515.1",  # RB32 (Tequatrovirus)
    "NC_018855.1",  # HX01 (Mosigvirus)
    "NC_012741.1",  # JS10 (Dhakavirus)
    "NC_014792.1",  # vB_EcoM-VR7 (Gaprivervirus)
    "NC_031087.1",  # Klebsiella phage vB_KpnM_KpV477 (Jiaodavirus)
    "NC_026607.2",  # Salmonella phage STP4-a (Gelderlandvirus)
    "NC_070776.1",  # Kosakonia phage 305 (Kanagawavirus)
    "NC_028857.1",  # Citrobacter phage Merlin (Moonvirus)
    "NC_023561.1",  # Enterobacter phage PG7 (Karamvirus)
    "NC_028820.1",  # Yersinia phage vB_YenM_TG1 (Tegunavirus)
    "NC_055728.1",  # Serratia phage X20 (Winklervirus)
    "NC_012635.1",  # RB51 (Tequatrovirus)
    "NC_024124.2",  # vB_EcoM_JS09 (Mosigvirus)
    "NC_014260.1",  # IME08 (Dhakavirus)
    "NC_028894.1",  # vB_EcoM_VR20 (Gaprivervirus)
    "NC_031095.1",  # Klebsiella phage PKO111 (Jiaodavirus)
]
# name: (clusters, CDS per cluster, methods). Large sits at the 800-protein cap for
# exact alignment, very large at the 6,000-gene cap overall.
TIERS = {
    "Small": (5, 10, ("global", "local", "diamond")),
    "Medium": (10, 20, ("global", "local", "diamond")),
    "Large": (20, 40, ("global", "local", "diamond")),
    "Very large": (30, 200, ("diamond",)),
}
METHODS = {"global": ("parasail", "global"), "local": ("parasail", "local"), "diamond": ("diamond", "global")}
LABELS = {"global": "Global", "local": "Local", "diamond": "DIAMOND"}
_POLL_S = 0.01


# --- HTTP -------------------------------------------------------------------

class RateLimited(Exception):
    def __init__(self, retry_after: float) -> None:
        self.retry_after = retry_after


def _request(url: str, data: bytes | None = None, headers: dict | None = None) -> dict:
    req = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(req) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            raise RateLimited(float(exc.headers.get("Retry-After", 5))) from None
        raise SystemExit(f"{req.get_method()} {url}: HTTP {exc.code} {exc.read().decode(errors='replace')}")


def _post_json(url: str, body: dict) -> dict:
    return _request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})


def _tier_files(tier: str) -> list[Path]:
    # Named explicitly rather than globbed: a synced folder (e.g. iCloud Desktop)
    # can leave conflict copies such as "01_NC_000866.4 2.gbk" beside them.
    folder = DATA / tier.lower().replace(" ", "_")
    return [folder / f"{i + 1:02d}_{acc}.gbk" for i, acc in enumerate(PANEL[: TIERS[tier][0]])]


def _upload(base: str, tier: str) -> str:
    boundary = uuid.uuid4().hex
    body = b""
    for p in _tier_files(tier):
        body += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{p.name}"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode() + p.read_bytes() + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    resp = _request(f"{base}/api/upload", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    return resp["upload_token"]


# --- inputs --------------------------------------------------------------------

def build_inputs() -> None:
    """Download PANEL once, then write each tier's clusters: the record from base 1
    to the end of its n-th CDS (by end coordinate), so exactly n CDS lie inside.
    A CDS wrapping the origin ends at the record end and so is never included."""
    from Bio import SeqIO  # from the backend's pixi env

    genomes = DATA / "genomes"
    genomes.mkdir(parents=True, exist_ok=True)
    for acc in PANEL:
        out = genomes / f"{acc}.gbk"
        if not out.exists():
            print(f"fetching {acc}", file=sys.stderr)
            url = ("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
                   f"?db=nuccore&id={acc}&rettype=gbwithparts&retmode=text")
            with urllib.request.urlopen(url) as resp:
                out.write_bytes(resp.read())
            time.sleep(0.4)  # NCBI anonymous limit: 3 requests/s

    for tier, (_k, n, _methods) in TIERS.items():
        for out, acc in zip(_tier_files(tier), PANEL):
            if out.exists():
                continue
            out.parent.mkdir(exist_ok=True)
            rec = SeqIO.read(genomes / f"{acc}.gbk", "genbank")
            ends = sorted(int(f.location.end) for f in rec.features if f.type == "CDS")
            sub = rec[: ends[n - 1]]
            got = sum(f.type == "CDS" for f in sub.features)
            if got != n:
                raise SystemExit(f"{acc}: cutting at the {n}th CDS end kept {got} CDS")
            sub.annotations = {**rec.annotations, "topology": "linear"}
            sub.description = f"{rec.description.rstrip('.')}, first {n} CDS"
            SeqIO.write(sub, out, "genbank")


def describe_tier(base: str, tier: str) -> dict:
    parsed = _post_json(f"{base}/api/parse", {"upload_token": _upload(base, tier)})
    per_cluster = [[g["translation"] for l in c["loci"] for g in l["genes"]] for c in parsed["clusters"]]
    proteins = [len(t) for genes in per_cluster for t in genes if t]
    sizes = [sum(1 for t in genes if t) for genes in per_cluster]
    return {
        "accessions": PANEL[: TIERS[tier][0]],
        "clusters": len(per_cluster),
        "cds": sum(map(len, per_cluster)),
        "proteins": len(proteins),
        "unique_proteins": len({t for genes in per_cluster for t in genes if t}),
        "cross_cluster_pairs": (sum(sizes) ** 2 - sum(s * s for s in sizes)) // 2,
        "total_aa": sum(proteins),
        "mean_aa": sum(proteins) / len(proteins),
    }


# --- timing --------------------------------------------------------------------

def time_job(base: str, tier: str, method: str) -> float:
    """Seconds for one job. Uploads fresh each time (outside the clock), which also
    keeps the scratch sweeper's 30 min TTL from deleting files mid-series."""
    token = _upload(base, tier)
    engine, mode = METHODS[method]
    while True:
        # The API allows 10 jobs per minute; a rejected submit creates no job, so
        # wait it out and restart the clock.
        start = time.perf_counter()
        try:
            job = _post_json(f"{base}/api/jobs", {"upload_token": token, "engine": engine, "mode": mode})
            break
        except RateLimited as exc:
            time.sleep(exc.retry_after)
    while True:
        status = _request(f"{base}/api/jobs/{job['job_id']}")
        if status["status"] == "succeeded":
            return time.perf_counter() - start
        if status["status"] in ("failed", "cancelled"):
            raise SystemExit(f"{tier}/{method}: {status['error'] or status['status']}")
        time.sleep(_POLL_S)


# --- report --------------------------------------------------------------------

def hardware(note: str) -> dict:
    hw = {"os": f"{platform.system()} {platform.release()}", "cpu": platform.processor() or platform.machine(),
          "logical_cpus": os.cpu_count(), "ram_gb": None, "python": platform.python_version(), "note": note}
    try:
        if sys.platform == "darwin":
            sysctl = lambda k: subprocess.run(["sysctl", "-n", k], capture_output=True, text=True).stdout.strip()
            hw["os"] = f"macOS {platform.mac_ver()[0]}"
            hw["cpu"] = sysctl("machdep.cpu.brand_string")
            hw["ram_gb"] = int(sysctl("hw.memsize")) / 2**30
            perf, eff = sysctl("hw.perflevel0.physicalcpu"), sysctl("hw.perflevel1.physicalcpu")
            if perf and eff:
                hw["cores"] = f"{perf} performance + {eff} efficiency cores"
        elif sys.platform.startswith("linux"):
            info = Path("/proc/cpuinfo").read_text().splitlines()
            hw["cpu"] = next(l.split(":", 1)[1].strip() for l in info if l.startswith("model name"))
            mem = Path("/proc/meminfo").read_text().splitlines()
            hw["ram_gb"] = int(next(l.split()[1] for l in mem if l.startswith("MemTotal"))) / 2**20
        elif sys.platform == "win32":
            import ctypes
            import winreg
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
            hw["cpu"] = winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()

            class MemStatus(ctypes.Structure):
                _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [
                    (f"f{i}", ctypes.c_ulonglong) for i in range(7)]
            ms = MemStatus(length=ctypes.sizeof(MemStatus))
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms))
            hw["ram_gb"] = ms.f0 / 2**30
    except Exception as exc:  # noqa: BLE001 — partial hardware info beats none
        print(f"hardware detection incomplete: {exc}", file=sys.stderr)
    return hw


def _fmt(s: float) -> str:
    return f"{s:.2f}" if s < 10 else f"{s:.1f}"


def table(results: list[dict]) -> str:
    multi = len(results) > 1
    head = "| Size | CDS | Shape | Total aa | Mean aa |" + (" Machine |" if multi else "")
    head += "".join(f" {LABELS[m]} |" for m in METHODS)
    lines = [head, "|" + "---|" * (head.count("|") - 1)]
    for tier, (k, n, _methods) in TIERS.items():
        for i, res in enumerate(results):
            t = res["tiers"][tier]
            cells = (
                [tier, f"{t['cds']:,}", f"{k} × {n}", f"{t['total_aa']:,}", f"{t['mean_aa']:.0f}"]
                if i == 0 else [""] * 5
            )
            if multi:
                cells.append(res["label"])
            for m in METHODS:
                x = res["times"].get(f"{tier}/{m}")
                cells.append(f"{_fmt(statistics.median(x))} ({_fmt(min(x))}–{_fmt(max(x))})" if x else "—")
            lines.append("| " + " | ".join(cells) + " |")
    runs = sorted({r["runs"] for r in results})
    lines += ["", f"Median wall-clock seconds over {'/'.join(map(str, runs))} runs (range in brackets), "
              "after one warmup run, measured against the Weft API "
              f"{', '.join(sorted({r['server']['version'] for r in results}))} on the same machine. "
              "Each run is one complete job (parse, align, group, order, result download); upload not timed. "
              "Global and local use parasail on a single thread; DIAMOND (blastp, default sensitivity) "
              "uses all logical CPUs. — : above Weft's 800-protein limit for exact alignment.", ""]
    for res in results:
        hw = res["hardware"]
        parts = [hw["cpu"], hw.get("cores") or f"{hw['logical_cpus']} logical CPUs"]
        if hw["ram_gb"]:
            parts.append(f"{hw['ram_gb']:.0f} GB RAM")
        parts.append(hw["os"])
        if hw["note"]:
            parts.append(hw["note"])
        lines.append(f"- {res['label'] + ': ' if multi else ''}{', '.join(parts)}")
    lines += ["", f"Inputs: the first n CDS of each of the first k genomes of {', '.join(PANEL)} "
              "(NCBI RefSeq, Tevenvirinae)."]
    return "\n".join(lines) + "\n"


def benchmark(args) -> None:
    base = args.url.rstrip("/")
    health = _request(f"{base}/api/health")
    if "diamond" not in health["engines"]:
        raise SystemExit("server has no DIAMOND binary; start it through the pixi env or the Docker image")
    if urllib.parse.urlparse(base).hostname not in ("localhost", "127.0.0.1", "::1"):
        print("warning: server is not local; the hardware recorded is this machine's", file=sys.stderr)

    build_inputs()
    tiers = {t: describe_tier(base, t) for t in TIERS}
    times: dict[str, list[float]] = {}
    for tier, (_k, _n, methods) in TIERS.items():
        for method in methods:
            time_job(base, tier, method)  # warmup
            times[f"{tier}/{method}"] = runs = [time_job(base, tier, method) for _ in range(args.runs)]
            print(f"{tier}/{method}: median {_fmt(statistics.median(runs))} s "
                  f"({', '.join(_fmt(r) for r in runs)})", file=sys.stderr)

    label = args.label or socket.gethostname().split(".")[0]
    result = {
        "label": label, "runs": args.runs, "server": {"url": base, "version": health["version"]},
        "hardware": hardware(args.note), "tiers": tiers, "times": times,
    }
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / f"{label}.json").write_text(json.dumps(result, indent=1))
    md = table([result])
    (RESULTS / f"{label}.md").write_text(md)
    print("\n" + md)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--label", help="machine name in the table and results file name (default: hostname)")
    ap.add_argument("--note", default="", help='hardware remark, e.g. "server in Docker Desktop (WSL 2)"')
    ap.add_argument("--table", action="store_true", help="merge results/*.json into one table and exit")
    args = ap.parse_args()

    if args.table:
        print(table([json.loads(p.read_text()) for p in sorted(RESULTS.glob("*.json"))]), end="")
    else:
        benchmark(args)


if __name__ == "__main__":
    main()
