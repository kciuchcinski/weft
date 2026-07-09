import { useRef } from "react";
import { useStore } from "../state/store";
import { describeAlignment } from "../render/layout";
import { exportSVG } from "../export";
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
      {/* connecting ribbon between the two homologous genes */}
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

// Minimal top bar (SPEC §6): brand + New/Load/Save/Export + job status.
export default function TopBar() {
  const jobStatus = useStore((s) => s.jobStatus);
  const togglePanel = useStore((s) => s.togglePanel);
  const data = useStore((s) => s.data);
  const hasData = !!data;
  const fileRef = useRef<HTMLInputElement>(null);

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
    download(new Blob([JSON.stringify(session)], { type: "application/json" }), "syntenic-session.json");
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
          Syntenic
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
        <button className="btn" onClick={onNew}>New</button>
        <button className="btn" onClick={() => fileRef.current?.click()}>Load</button>
        <button className="btn" onClick={onSave} disabled={!hasData}>Save</button>
        <button className="btn btn-primary" onClick={() => exportSVG(useStore.getState())} disabled={!hasData}>
          Export
        </button>
        <span className="job-status" data-status={jobStatus}>
          <span className="status-dot" />
          {jobStatus}
        </span>
        <input ref={fileRef} type="file" accept=".json" hidden onChange={onLoadFile} />
      </div>
    </header>
  );
}
