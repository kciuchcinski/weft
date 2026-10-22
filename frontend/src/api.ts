import type { FigureData } from "./types";
import type { Session } from "./state/store";

async function getJSON(path: string): Promise<any> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

async function postJSON(path: string, body: unknown): Promise<any> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Engines this deployment can actually run (parasail always; DIAMOND only where its binary is present). */
export interface Capabilities {
  engines: string[];
  defaultEngine: string;
  version: string | null; // backend version, if reported
}

let capabilities: Promise<Capabilities> | null = null;

/** Ask the backend which engines are available so the UI can hide ones it can't run.
 * Memoized so every caller shares one /api/health request; a failure is not cached. */
export function fetchCapabilities(): Promise<Capabilities> {
  capabilities ??= loadCapabilities().catch((err) => {
    capabilities = null;
    throw err;
  });
  return capabilities;
}

async function loadCapabilities(): Promise<Capabilities> {
  const h = await getJSON("/api/health");
  const engines: string[] = Array.isArray(h.engines) && h.engines.length ? h.engines : ["parasail"];
  return {
    engines,
    defaultEngine: h.default_engine ?? engines[0] ?? "parasail",
    version: typeof h.version === "string" ? h.version : null,
  };
}

type OnStatus = (status: string) => void;

/** Alignment job parameters (see backend JobRequest). */
export interface JobParams {
  engine?: string; // "diamond" | "parasail"
  mode?: string; // "global" | "local" (parasail only)
  identity_cutoff?: number; // minimum identity to keep a link (0–1)
  evalue_cutoff?: number; // maximum E-value to keep a hit (DIAMOND only)
}

/** Drop empty params so the backend applies its own JobRequest defaults. */
function jobBody(base: Record<string, unknown>, params?: JobParams): Record<string, unknown> {
  const body = { ...base };
  if (params?.engine) body.engine = params.engine;
  if (params?.mode) body.mode = params.mode;
  if (params?.identity_cutoff != null) body.identity_cutoff = params.identity_cutoff;
  if (params?.evalue_cutoff != null) body.evalue_cutoff = params.evalue_cutoff;
  return body;
}

async function pollJob(jobId: string, onStatus?: OnStatus): Promise<FigureData> {
  for (;;) {
    const s = await getJSON(`/api/jobs/${jobId}`);
    onStatus?.(s.status);
    if (s.status === "succeeded") return s.result as FigureData;
    if (s.status === "failed") throw new Error(s.error || "job failed");
    await sleep(300);
  }
}

/**
 * Load the bundled example. Rather than re-running DIAMOND, this fetches a
 * curated session (figure data + a saved view: three lanes with phage1 shown
 * both intact and split across one row, coloured by the PHROG "function" field)
 * built ahead of time by `pixi run example`.
 */
export async function loadExampleSession(onStatus?: OnStatus): Promise<Session> {
  onStatus?.("loading example");
  return (await getJSON("/example_session.json")) as Session;
}

/** Upload GenBank files, then run + poll a job on them. */
export async function runUploadJob(files: File[], onStatus?: OnStatus, params?: JobParams): Promise<FigureData> {
  onStatus?.("uploading");
  const fd = new FormData();
  files.forEach((f) => fd.append("files", f));
  const up = await fetch("/api/upload", { method: "POST", body: fd });
  if (!up.ok) throw new Error(`upload → ${up.status}`);
  const { upload_token } = await up.json();
  onStatus?.("submitting");
  const { job_id } = await postJSON("/api/jobs", jobBody({ upload_token }, params));
  return pollJob(job_id, onStatus);
}
