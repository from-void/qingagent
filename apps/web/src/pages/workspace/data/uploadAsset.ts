export interface UploadedAsset {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface UploadAssetOptions {
  onProgress?: (progress: number | null) => void;
}

export async function uploadAssetFile(file: File, options: UploadAssetOptions = {}): Promise<UploadedAsset> {
  const content = await fileToBase64(file);
  return uploadJson(
    file,
    JSON.stringify({
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      content,
    }),
    options,
  );
}

export function uploadedAssetUrl(asset: Pick<UploadedAsset, "fileId" | "filename">): string {
  return `/api/v1/files/${encodeURIComponent(asset.fileId)}/${encodeURIComponent(asset.filename)}`;
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = typeof file.arrayBuffer === "function"
    ? await file.arrayBuffer()
    : await readFileAsArrayBuffer(file);
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }
      reject(new Error(`Failed to read ${file.name}`));
    };
    reader.readAsArrayBuffer(file);
  });
}

function uploadJson(file: File, body: string, options: UploadAssetOptions): Promise<UploadedAsset> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/v1/upload");
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) {
        options.onProgress?.(null);
        return;
      }
      options.onProgress?.(Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100))));
    };
    xhr.onerror = () => reject(new Error(`Upload failed for ${file.name}: network error`));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        const detail = readUploadErrorText(xhr.responseText);
        reject(new Error(detail || `Upload failed for ${file.name}: ${xhr.status}`));
        return;
      }
      try {
        resolve(JSON.parse(xhr.responseText) as UploadedAsset);
      } catch {
        reject(new Error(`Upload failed for ${file.name}: invalid response`));
      }
    };
    xhr.send(body);
  });
}

function readUploadErrorText(text: string): string | null {
  if (!text) return null;

  try {
    const body = JSON.parse(text) as unknown;
    const error = readStringField(body, "error");
    if (error) return error;
    const message = readStringField(body, "message");
    if (message) return message;
    const detail = readStringField(body, "detail");
    if (detail) return detail;
  } catch {
    return null;
  }
  return null;
}

function readStringField(value: unknown, field: "error" | "message" | "detail"): string | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[field];
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const message = (raw as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return null;
}
