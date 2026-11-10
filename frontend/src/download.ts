/** File types offered in the native save dialog, keyed by extension. */
const FILE_TYPES: Record<string, { description: string; mime: string }> = {
  svg: { description: "SVG image", mime: "image/svg+xml" },
  png: { description: "PNG image", mime: "image/png" },
  json: { description: "Weft session", mime: "application/json" },
  csv: { description: "CSV table", mime: "text/csv" },
};

interface SaveFilePickerWindow {
  showSaveFilePicker?: (opts: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{ createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }>;
}

/**
 * Save a Blob under `filename`. Where the browser supports it (Chromium), a native
 * "Save as" dialog lets the user pick the name and folder; elsewhere this falls
 * back to a regular download, which follows the browser's own download settings.
 */
export async function saveFile(blob: Blob, filename: string): Promise<void> {
  const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;
  if (picker) {
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    const type = FILE_TYPES[ext];
    try {
      const handle = await picker.call(window, {
        suggestedName: filename,
        types: type ? [{ description: type.description, accept: { [type.mime]: [`.${ext}`] } }] : undefined,
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      // The user closed the dialog: nothing to save.
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Anything else (e.g. no user activation left after an async step, or a
      // sandboxed frame): fall back to a plain download rather than losing the file.
      console.warn("Save dialog unavailable, downloading instead:", err);
    }
  }
  download(blob, filename);
}

/** Trigger a browser download for a Blob. */
function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
