import { useEffect, useRef } from "react";
import { useStore } from "../state/store";
import { describeAlignment } from "../render/layout";
import { exportAlignmentTableCSV, exportPNG, exportSimilarityMatrixCSV, exportSVG } from "../export";
import { download } from "../download";

// A compact synteny glyph: two aligned rows of gene arrows joined by a link
// ribbon, echoing what the app produces. Rendered as the brand mark.
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="synMark" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5a7cf0" />
          <stop offset="1" stopColor="#2b50c4" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="7" fill="url(#synMark)" />
      {/* connecting ribbon between the two similar genes */}
      <path d="M8 9.4 L14.6 9.4 L13.4 14.6 L6.8 14.6 Z" fill="#fff" fillOpacity="0.22" />
      {/* top row */}
      <path d="M5 8 h4.6 l1.6 1.5 -1.6 1.5 H5 Z" fill="#fff" fillOpacity="0.95" />
      <path d="M12.4 8 h6.6 v3 h-6.6 l1.4 -1.5 Z" fill="#fff" fillOpacity="0.6" />
      {/* bottom row (shifted — synteny with rearrangement) */}
      <path d="M5 13 h3.6 v3 H5 l1.4 -1.5 Z" fill="#fff" fillOpacity="0.6" />
      <path d="M9.8 13 h6.6 l1.6 1.5 -1.6 1.5 H9.8 Z" fill="#fff" fillOpacity="0.95" />
    </svg>
  );
}

// Curved-arrow undo/redo icons (stroke-only, inherit the button's text colour).
function UndoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </svg>
  );
}

// Top bar: brand + undo/redo + session (New/Open/Save) + figure/data Export + job status.
// Save/Open round-trip the editable session (.json); Export writes the figure or
// similarity data out to other formats — the usual native-file vs export split.
export default function TopBar() {
  const jobStatus = useStore((s) => s.jobStatus);
  const togglePanel = useStore((s) => s.togglePanel);
  const data = useStore((s) => s.data);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const hasData = !!data;
  const fileRef = useRef<HTMLInputElement>(null);

  // Keyboard: ⌘Z / Ctrl+Z to undo, ⇧⌘Z or Ctrl+Y to redo. Ignore while typing in
  // an input (so the rename editor keeps native text undo).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z" && e.key.toLowerCase() !== "y") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      const redo = e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey);
      if (redo) useStore.getState().redo();
      else useStore.getState().undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Base info: how much is loaded and which alignment produced it.
  const clusterCount = data?.clusters.length ?? 0;
  const geneCount = data
    ? data.clusters.reduce((n, c) => n + c.loci.reduce((m, l) => m + l.genes.length, 0), 0)
    : 0;
  const align = describeAlignment(data);
  const alignLabel = align.engine
    ? align.mode
      ? `${align.mode} mode (${align.engine})`
      : align.engine
    : null;

  const onNew = () => useStore.getState().newSession();

  const onSave = () => {
    const session = useStore.getState().getSession();
    download(new Blob([JSON.stringify(session)], { type: "application/json" }), "weft-session.json");
  };

  const onLoadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      useStore.getState().loadSession(JSON.parse(await file.text()));
    } catch (err) {
      console.error(err);
    }
    e.target.value = "";
  };

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="icon-btn" title="Toggle control panel" onClick={togglePanel}>☰</button>
        <span className="brand">
          <BrandMark />
          Weft
        </span>
        {hasData && (
          <span className="topbar-info">
            <span className="topbar-info-sep">·</span>
            {clusterCount} {clusterCount === 1 ? "cluster" : "clusters"} · {geneCount} genes
            {alignLabel && (
              <>
                <span className="topbar-info-sep">·</span>
                {alignLabel}
              </>
            )}
          </span>
        )}
      </div>
      <div className="topbar-actions">
        <span className="history-btns">
          <button className="btn btn-icon" onClick={() => useStore.getState().undo()} disabled={!canUndo} title="Undo (⌘Z)" aria-label="Undo"><UndoIcon /></button>
          <button className="btn btn-icon" onClick={() => useStore.getState().redo()} disabled={!canRedo} title="Redo (⇧⌘Z)" aria-label="Redo"><RedoIcon /></button>
        </span>
        <button className="btn" onClick={onNew} title="Clear the canvas and start over">New</button>
        <button className="btn" onClick={() => fileRef.current?.click()} title="Open a saved Weft session (.json)">Open session</button>
        <button className="btn" onClick={onSave} disabled={!hasData} title="Save the editable session (.json) to reopen later">Save session</button>
        <details className="topbar-export">
          <summary className={"btn btn-primary" + (!hasData ? " is-disabled" : "")} onClick={(e) => { if (!hasData) e.preventDefault(); }} title="Export the figure (SVG/PNG) or similarity data (CSV)">
            Export
            <svg className="export-caret" viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m3 4.5 3 3 3-3" />
            </svg>
          </summary>
          {hasData && (
            <div className="topbar-export-menu">
              <p>Figure</p>
              <button onClick={() => exportSVG(useStore.getState())}>SVG</button>
              <button onClick={() => exportPNG(useStore.getState())}>PNG</button>
              <p>Similarity data</p>
              <button onClick={() => exportAlignmentTableCSV(useStore.getState())}>Alignment CSV</button>
              <button onClick={() => exportSimilarityMatrixCSV(useStore.getState())}>Matrix CSV</button>
            </div>
          )}
        </details>
        <span className="job-status" data-status={jobStatus}>
          <span className="status-dot" />
          {jobStatus}
        </span>
        <input ref={fileRef} type="file" accept=".json" hidden onChange={onLoadFile} />
      </div>
    </header>
  );
}
