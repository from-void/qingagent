import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PmDoc } from "@qingagent/pm-schema";
import {
  __resetDocumentsClientForTest,
} from "../documentsClient.js";
import { __resetMigrationsForTest } from "../migrations.js";
import type { DocumentSaveInput } from "../documentRepo.js";

export interface TempDocumentsDb {
  tempDir: string;
  cleanup: () => void;
}

export function prepareTempDocumentsDb(prefix: string): TempDocumentsDb {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  process.env.DATABASE_URL = `file:${join(tempDir, "documents.db")}`;
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
  return {
    tempDir,
    cleanup: () => {
      __resetDocumentsClientForTest();
      __resetMigrationsForTest();
      delete process.env.DATABASE_URL;
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

export function section(text: string) {
  return { kind: "p", data: { text } };
}

export function pmDocFromText(text: string): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "paragraph",
      attrs: { blockId: "test-paragraph" },
      content: text ? [{ type: "text", text }] : [],
    }],
  };
}

export function documentInput(
  id: string,
  overrides: Partial<DocumentSaveInput> = {},
): DocumentSaveInput {
  return {
    id,
    threadId: `thread-${id}`,
    resourceId: "qingagent-user",
    title: `title-${id}`,
    docState: "editing",
    docVersion: 1,
    lastSyncedVersion: 1,
    pmDoc: overrides.pmDoc ?? pmDocFromText(`body-${id}`),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
