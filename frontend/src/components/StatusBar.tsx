import { useEffect, useState } from "react";
import { fetchCapabilities } from "../api";

const REPO_URL = "https://github.com/kciuchcinski/weft";
// Set once the paper is out (bare DOI, e.g. "10.1234/abcd"); until then the bar
// shows a placeholder.
const PAPER_DOI: string | null = null;

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

// Sidebar footer: name + version on the left, paper citation and source link on the right.
// The frontend version is baked in at build time; the API's comes from /api/health
// and is only spelled out when the two differ (e.g. a stale deploy).
export default function StatusBar() {
  const [apiVersion, setApiVersion] = useState<string | null>(null);

  useEffect(() => {
    fetchCapabilities()
      .then((c) => setApiVersion(c.version))
      .catch(() => setApiVersion(null));
  }, []);

  const mismatch = apiVersion && apiVersion !== __APP_VERSION__;

  return (
    <footer className="statusbar">
      <div className="statusbar-left">
        <span className="statusbar-name">Weft</span>
        <span className="statusbar-version" title={apiVersion ? `App v${__APP_VERSION__} · API v${apiVersion}` : `App v${__APP_VERSION__}`}>
          v{__APP_VERSION__}
          {mismatch && <> · API v{apiVersion}</>}
        </span>
      </div>
      <div className="statusbar-right">
        {PAPER_DOI ? (
          <a href={`https://doi.org/${PAPER_DOI}`} target="_blank" rel="noreferrer" title="Cite Weft">
            doi:{PAPER_DOI}
          </a>
        ) : (
          <span className="statusbar-placeholder">Paper: coming soon</span>
        )}
        <span aria-hidden="true">·</span>
        <a href={REPO_URL} target="_blank" rel="noreferrer" title="Source code on GitHub">
          <GitHubIcon />
          GitHub
        </a>
      </div>
    </footer>
  );
}
