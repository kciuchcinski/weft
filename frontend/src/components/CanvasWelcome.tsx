import { useRef, useState } from "react";
import { useStore } from "../state/store";
import { loadExampleSession } from "../api";
import { useUpload } from "../state/useUpload";

// Gene arrow slots shared by both lanes. The bottom lane reuses the same
// x-slots in a shuffled order so a couple of ribbons cross — a tiny, honest
// depiction of the synteny-with-rearrangement this tool is built to show.
const SLOTS = [
  [20, 78],
  [90, 148],
  [160, 218],
  [230, 288],
] as const;

const COLOURS = ["#3862e0", "#14b8a6", "#f59e0b", "#f43f5e"];
const TOP = [0, 1, 2, 3]; // gene → slot for the top lane
const BOTTOM = [0, 2, 1, 3]; // gene → slot for the bottom lane (B/C swapped)

const Y_TOP = 30;
const Y_BOTTOM = 82;
const GENE_H = 18;
const TIP = 9;

function arrowPath(x0: number, x1: number, y0: number): string {
  const h = GENE_H;
  const r = 3;
  return [
    `M ${x0 + r} ${y0}`,
    `H ${x1 - TIP}`,
    `L ${x1} ${y0 + h / 2}`,
    `L ${x1 - TIP} ${y0 + h}`,
    `H ${x0 + r}`,
    `Q ${x0} ${y0 + h} ${x0} ${y0 + h - r}`,
    `V ${y0 + r}`,
    `Q ${x0} ${y0} ${x0 + r} ${y0}`,
    "Z",
  ].join(" ");
}

function ribbonPath(top: readonly [number, number], bot: readonly [number, number]): string {
  const yT = Y_TOP + GENE_H;
  const yB = Y_BOTTOM;
  const mid = (yT + yB) / 2;
  const [tx0, tx1] = top;
  const [bx0, bx1] = bot;
  return `M ${tx0} ${yT} C ${tx0} ${mid} ${bx0} ${mid} ${bx0} ${yB} L ${bx1} ${yB} C ${bx1} ${mid} ${tx1} ${mid} ${tx1} ${yT} Z`;
}

// A living version of the brand glyph: two aligned rows of gene arrows joined
// by similarity ribbons, drawn in with a gentle stagger. This is exactly the kind
// of figure the app produces, so the empty state previews the payoff.
function HeroGlyph() {
  return (
    <div className="welcome-hero" aria-hidden="true">
      <svg viewBox="0 0 308 118" fill="none" xmlns="http://www.w3.org/2000/svg">
        <g className="welcome-ribbons">
          {TOP.map((_, gene) => (
            <path
              key={gene}
              className="welcome-ribbon"
              style={{ animationDelay: `${0.45 + gene * 0.08}s` }}
              d={ribbonPath(SLOTS[TOP[gene]], SLOTS[BOTTOM[gene]])}
              fill={COLOURS[gene]}
            />
          ))}
        </g>
        {TOP.map((slot, gene) => {
          const [x0, x1] = SLOTS[slot];
          return (
            <path
              key={`t${gene}`}
              className="welcome-gene"
              style={{ animationDelay: `${gene * 0.07}s` }}
              d={arrowPath(x0, x1, Y_TOP)}
              fill={COLOURS[gene]}
            />
          );
        })}
        {BOTTOM.map((slot, gene) => {
          const [x0, x1] = SLOTS[slot];
          return (
            <path
              key={`b${gene}`}
              className="welcome-gene"
              style={{ animationDelay: `${0.12 + gene * 0.07}s` }}
              d={arrowPath(x0, x1, Y_BOTTOM)}
              fill={COLOURS[gene]}
            />
          );
        })}
      </svg>
    </div>
  );
}

const STATUS_COPY: Record<string, string> = {
  uploading: "Uploading files…",
  submitting: "Submitting job…",
  queued: "Queued…",
  running: "Aligning sequences with DIAMOND…",
  "loading example": "Loading example…",
};

function Spinner() {
  return (
    <svg className="spinner" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle className="spinner-track" cx="12" cy="12" r="9" strokeWidth="3" fill="none" />
      <circle className="spinner-head" cx="12" cy="12" r="9" strokeWidth="3" fill="none" />
    </svg>
  );
}

export default function CanvasWelcome() {
  const loadSession = useStore((s) => s.loadSession);
  const setJobStatus = useStore((s) => s.setJobStatus);
  const jobStatus = useStore((s) => s.jobStatus);
  const fileRef = useRef<HTMLInputElement>(null);

  // Shared with the left panel: choosing files stages them; Run starts the job.
  const { staged, stageFiles, runStaged, clearStaged, loading } = useUpload();
  const [exampleLoading, setExampleLoading] = useState(false);
  const [drag, setDrag] = useState(false);
  const busy = loading || exampleLoading;

  const runExample = async () => {
    setExampleLoading(true);
    try {
      loadSession(await loadExampleSession(setJobStatus));
      setJobStatus("idle");
    } catch (e) {
      setJobStatus("failed");
      console.error(e);
    } finally {
      setExampleLoading(false);
    }
  };

  const failed = !busy && (jobStatus === "failed" || jobStatus === "no supported files");
  const statusLabel = STATUS_COPY[jobStatus] ?? "Working…";

  return (
    <div
      className={"welcome" + (drag ? " drag" : "") + (busy ? " busy" : "")}
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (!busy) stageFiles(e.dataTransfer.files);
      }}
    >
      <div className="welcome-card">
        <HeroGlyph />

        {busy ? (
          <div className="welcome-loading">
            <div className="welcome-status">
              <Spinner />
              <span>{statusLabel}</span>
            </div>
            <p className="welcome-sub">
              Parsing input, running all-vs-all alignment, and grouping similar genes. Hang tight — this can
              take a moment on real data.
            </p>
          </div>
        ) : staged.length > 0 ? (
          <>
            <h1 className="welcome-title">{staged.length} file{staged.length === 1 ? "" : "s"} ready to align</h1>
            <p className="welcome-sub">
              Choose an alignment method and thresholds in the panel on the left, then run.
            </p>

            <ul className="welcome-staged">
              {staged.map((f) => <li key={f.name}>{f.name}</li>)}
            </ul>

            {failed && (
              <div className="welcome-alert" role="alert">
                {jobStatus === "no supported files"
                  ? "Those files aren’t supported. Try GenBank (.gbk/.gb) or GFF3/GTF with FASTA."
                  : "Something went wrong running that job. Check the backend is running, then try again."}
              </div>
            )}

            <div className="welcome-actions">
              <button className="btn btn-primary btn-lg" onClick={runStaged}>
                Run alignment on {staged.length} file{staged.length === 1 ? "" : "s"}
              </button>
              <button className="btn btn-lg" onClick={() => fileRef.current?.click()}>
                Add files
              </button>
            </div>

            <p className="welcome-hint">
              <button className="link-btn" onClick={clearStaged}>Clear staged files</button>
            </p>
          </>
        ) : (
          <>
            <h1 className="welcome-title">Compare gene clusters, beautifully.</h1>
            <p className="welcome-sub">
              Drop in GenBank or GFF3/GTF&nbsp;+&nbsp;FASTA files to line up similar genes across
              clusters — then refine the figure and export it publication-ready.
            </p>

            {failed && (
              <div className="welcome-alert" role="alert">
                {jobStatus === "no supported files"
                  ? "Those files aren’t supported. Try GenBank (.gbk/.gb) or GFF3/GTF with FASTA."
                  : "Something went wrong running that job. Check the backend is running, then try again."}
              </div>
            )}

            <div className="welcome-actions">
              <button className="btn btn-primary btn-lg" onClick={runExample}>
                Load example dataset
              </button>
              <button className="btn btn-lg" onClick={() => fileRef.current?.click()}>
                Choose files
              </button>
            </div>

            <p className="welcome-hint">
              …or drag &amp; drop files anywhere on this canvas.
            </p>
          </>
        )}

        <input
          ref={fileRef}
          type="file"
          accept=".gbk,.gb,.genbank,.gbf,.gbff,.gff,.gff3,.gtf,.fa,.fna,.fasta,.fas,.faa"
          multiple
          hidden
          onChange={(e) => { stageFiles(e.target.files); e.target.value = ""; }}
        />
      </div>

      {drag && <div className="welcome-dropveil">Drop to load</div>}
    </div>
  );
}
