/**
 * CORE CONTRACT — platform file access. Uses native dialogs + Rust commands
 * inside Tauri; falls back to browser download / <input type=file> in `npm run dev`.
 */
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export interface FileFilter {
  name: string;
  extensions: string[];
}

export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function browserDownload(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Ask for a save path (unless `path` is given) and write text. Returns the path written, or null if cancelled. */
export async function saveText(
  contents: string,
  defaultName: string,
  filters: FileFilter[],
  path?: string | null,
): Promise<string | null> {
  if (!isTauri()) {
    browserDownload(new Blob([contents], { type: "text/plain" }), defaultName);
    return defaultName;
  }
  const target = path ?? (await save({ defaultPath: defaultName, filters }));
  if (!target) return null;
  await invoke("write_text_file", { path: target, contents });
  return target;
}

export async function saveBinary(blob: Blob, defaultName: string, filters: FileFilter[]): Promise<string | null> {
  if (!isTauri()) {
    browserDownload(blob, defaultName);
    return defaultName;
  }
  const target = await save({ defaultPath: defaultName, filters });
  if (!target) return null;
  await invoke("write_binary_file", { path: target, base64Data: await blobToBase64(blob) });
  return target;
}

/** Ask the user to pick a file and return its path + text, or null if cancelled. */
export async function openText(filters: FileFilter[]): Promise<{ path: string; contents: string } | null> {
  if (!isTauri()) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = filters.flatMap((f) => f.extensions.map((e) => "." + e)).join(",");
      input.onchange = async () => {
        const f = input.files?.[0];
        resolve(f ? { path: f.name, contents: await f.text() } : null);
      };
      input.click();
    });
  }
  const picked = await open({ multiple: false, directory: false, filters });
  if (!picked || Array.isArray(picked)) return null;
  const contents = await invoke<string>("read_text_file", { path: picked });
  return { path: picked, contents };
}
