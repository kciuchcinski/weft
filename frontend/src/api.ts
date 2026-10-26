import type { FigureData } from "./types";
import type { Session } from "./state/store";

const UNREACHABLE = "Couldn’t reach the Weft server. Check the backend is running, then try again.";

/** Text of a thrown error, for showing to the user. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** fetch + JSON, throwing an Error whose message is fit to show the user. */
async function request(path: string, init?: RequestInit): Promise<any> {
  let r: Response;
  try {
    r = await fetch(path, init);
  } catch {
    throw new Error(UNREACHABLE); // network failure: nothing answered at all
  }
  if (!r.ok) throw new Error(await failureText(r));
  return r.json();
}

/** FastAPI explains rejections in `detail` (a string, or a list of validation
 * issues). A 5xx without one is a dead backend behind the dev proxy or host. */
async function failureText(r: Response): Promise<string> {
  const body = await r.json().catch(() => null);
  const detail = body?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length) return detail.map((d) => d?.msg ?? String(d)).join("; ");
  return r.status >= 500 ? UNREACHABLE : `Request failed (${r.status} ${r.statusText}).`;
}

const getJSON = (path: string) => request(path);

const postJSON = (path: string, body: unknown) =>
  request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

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
  separate_records?: string[]; // file names whose records each become their own sequence
}

/** Drop empty params so the backend applies its own JobRequest defaults. */
function jobBody(base: Record<string, unknown>, params?: JobParams): Record<string, unknown> {
  const body = { ...base };
  if (params?.engine) body.engine = params.engine;
  if (params?.mode) body.mode = params.mode;
  if (params?.identity_cutoff != null) body.identity_cutoff = params.identity_cutoff;
  if (params?.evalue_cutoff != null) body.evalue_cutoff = params.evalue_cutoff;
  if (params?.separate_records?.length) body.separate_records = params.separate_records;
  return body;
}

async function pollJob(jobId: string, onStatus?: OnStatus): Promise<FigureData> {
  for (;;) {
    const s = await getJSON(`/api/jobs/${jobId}`);
    onStatus?.(s.status);
    if (s.status === "succeeded") return s.result as FigureData;
    if (s.status === "failed") throw new Error(s.error || "The job failed without reporting why.");
    if (s.status === "cancelled") throw new Error("The job was cancelled.");
    await sleep(300);
  }
}

/**
 * Load the bundled example: a static, precomputed session (figure data + saved
 * view) for the OXA-232 / ColKP3 plasmids — nothing is computed on the server.
 * It is a copy of examples/OXA-232/Figure1/Figure1-weft-session.json; to change
 * the example, save a session from the app and replace public/example_session.json.
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
  const { upload_token } = await request("/api/upload", { method: "POST", body: fd });
  onStatus?.("submitting");
  const { job_id } = await postJSON("/api/jobs", jobBody({ upload_token }, params));
  return pollJob(job_id, onStatus);
}
