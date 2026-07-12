import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { uploadsBaseDir } from "../paths/uploadsDir.js";

export async function persistScreenshot(buffer: Buffer): Promise<string> {
  const imageId = randomUUID();
  const imageDir = join(uploadsBaseDir(), imageId);
  await mkdir(imageDir, { recursive: true });
  await writeFile(join(imageDir, "screenshot.jpg"), buffer);
  return "/api/v1/files/" + imageId + "/screenshot.jpg";
}
