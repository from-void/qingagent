import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { uploadsBaseDir } from "../paths/uploadsDir.js";

export async function persistScreenshot(buffer: Buffer, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const imageId = randomUUID();
  const imageDir = join(uploadsBaseDir(), imageId);
  let persisted = false;
  try {
    await mkdir(imageDir, { recursive: true });
    signal?.throwIfAborted();
    await writeFile(join(imageDir, "screenshot.jpg"), buffer);
    signal?.throwIfAborted();
    persisted = true;
    return "/api/v1/files/" + imageId + "/screenshot.jpg";
  } finally {
    if (!persisted) {
      await rm(imageDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
