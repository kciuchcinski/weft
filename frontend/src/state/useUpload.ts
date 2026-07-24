import { useState } from "react";
import { runUploadJob } from "../api";
import { useStore } from "./store";

/** Accepted input extensions (GenBank, GFF/GTF, FASTA). */
export const INPUT_RE = /\.(gbk|gb|genbank|gbf|gbff|gff|gff3|gtf|fa|fna|fasta|fas|faa)$/i;

/**
 * Shared upload flow for the left panel and the welcome screen: choosing files
 * *stages* them (into the store, so both surfaces see one queue) and an explicit
 * Run action starts the alignment job with the current engine/threshold settings.
 * Staged files survive a run so the user can change the method and re-run the same
 * inputs; session resets (New / load / example) clear the queue.
 */
export function useUpload() {
  const staged = useStore((s) => s.staged);
  const setStaged = useStore((s) => s.setStaged);
  const setData = useStore((s) => s.setData);
  const setJobStatus = useStore((s) => s.setJobStatus);
  const [loading, setLoading] = useState(false);

  const stageFiles = (fileList: FileList | null) => {
    if (!fileList) return;
    const picked = [...fileList].filter((f) => INPUT_RE.test(f.name));
    if (!picked.length) {
      setJobStatus("no supported files");
      return;
    }
    // Merge with the existing queue (read live to avoid a stale closure), keyed by
    // name so repeated drops accumulate and re-picking a file replaces it.
    const byName = new Map(useStore.getState().staged.map((f) => [f.name, f]));
    picked.forEach((f) => byName.set(f.name, f));
    setStaged([...byName.values()]);
    setJobStatus("ready");
  };

  const clearStaged = () => {
    setStaged([]);
    setJobStatus("idle");
  };

  const runStaged = async () => {
    const files = useStore.getState().staged;
    if (!files.length || loading) return;
    const { engine, mode, identityCutoff, evalueCutoff } = useStore.getState();
    setLoading(true);
    try {
      setData(
        await runUploadJob(files, setJobStatus, {
          engine,
          mode,
          identity_cutoff: identityCutoff,
          evalue_cutoff: evalueCutoff,
        }),
      );
    } catch (e) {
      setJobStatus("failed");
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return { staged, stageFiles, runStaged, clearStaged, loading };
}
