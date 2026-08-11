import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import {
  ensureMigrated,
  getAppSetting,
  getDocumentsClient,
} from "@qingagent/db";
import {
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface SeedOptions {
  fixturesDir: string;
}

let db: TempDocumentsDb;

beforeEach(() => {
  db = prepareTempDocumentsDb("qingagent-seed-v2-");
  process.env.QINGAGENT_UPLOADS_DIR = join(db.tempDir, "uploads");
});

afterEach(() => {
  delete process.env.QINGAGENT_UPLOADS_DIR;
  db.cleanup();
});

async function writeMinimalFixture(fixturesDir: string): Promise<void> {
  const assetDir = join(fixturesDir, "assets", "asset-1");
  await mkdir(assetDir, { recursive: true });
  await writeFile(join(assetDir, "source.png"), "fixture-image");
  await writeFile(
    join(fixturesDir, "manifest.json"),
    JSON.stringify({ order: ["piece-one"] }),
  );
  await writeFile(
    join(fixturesDir, "briefings.json"),
    JSON.stringify({ _common: "公共简报", "piece-one": "单篇简报" }),
  );
  await writeFile(
    join(fixturesDir, "piece-one.json"),
    JSON.stringify({
      piece: "piece-one",
      sessionId: "thread-one",
      threads: [
        {
          id: "thread-one",
          resourceId: "qingagent-user",
          title: "真实示例",
          metadata: { __b64__: Buffer.from("thread-meta").toString("base64") },
          createdAt: "2026-08-11T18:18:15.127Z",
          updatedAt: "2026-08-11T18:18:54.432Z",
        },
        {
          id: "om-sidecar:thread-one",
          resourceId: "qingagent-user",
          title: "",
          metadata: { __b64__: Buffer.from("sidecar-meta").toString("base64") },
          createdAt: "2026-08-11T18:18:54.414Z",
          updatedAt: "2026-08-11T18:18:54.416Z",
        },
      ],
      documents: [
        {
          id: "doc-main",
          thread_id: "thread-one",
          resource_id: "qingagent-user",
          title: "真实示例",
          doc_state: "editing",
          doc_version: 1,
          last_synced_version: 1,
          doc_pm: "{}",
          doc_schema_version: 1,
          content_hash: "main-hash",
          doc_format: "pm_json",
          version: 1,
          created_at: "2026-08-11T18:18:53.198Z",
          updated_at: "2026-08-11T18:18:53.198Z",
          role: "main",
        },
        {
          id: "doc-derived",
          thread_id: "thread-one",
          resource_id: "qingagent-user",
          title: "衍生稿",
          doc_state: "editing",
          doc_version: 1,
          last_synced_version: 1,
          doc_pm: "{}",
          doc_schema_version: 1,
          content_hash: "derived-hash",
          doc_format: "pm_json",
          version: 1,
          created_at: "2026-08-11T18:19:53.198Z",
          updated_at: "2026-08-11T18:19:53.198Z",
          role: "derivative",
        },
      ],
      derivatives: [
        {
          doc_id: "doc-derived",
          source_doc_id: "doc-main",
          dtype: "gzh",
          template_id: "gzh-deep",
          layout_style_id: "gzh-layout-classic",
          private_prompt: "",
          source_version: 1,
          generated_at: "2026-08-11T18:19:53.198Z",
          created_at: "2026-08-11T18:19:13.198Z",
          updated_at: "2026-08-11T18:19:53.198Z",
          cover_template: "poster",
          target_lang: null,
        },
      ],
      assetFileIds: ["asset-1"],
    }),
  );
}

describe("seedInitialContent fixture v2", () => {
  it("搬运整行、改写时间、复制资源、注入简报并保持幂等", async () => {
    const fixturesDir = join(db.tempDir, "fixtures");
    await mkdir(fixturesDir, { recursive: true });
    await writeMinimalFixture(fixturesDir);

    await ensureMigrated();
    const client = getDocumentsClient();
    await client.execute(`CREATE TABLE mastra_threads (
      id TEXT PRIMARY KEY,
      resourceId TEXT NOT NULL,
      title TEXT,
      metadata BLOB,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`);

    const { seedInitialContent } = await import("../seed/seedInitialContent.js");
    const seedWithOptions = seedInitialContent as unknown as (
      options: SeedOptions,
    ) => Promise<void>;
    await seedWithOptions({ fixturesDir });
    await seedWithOptions({ fixturesDir });

    const threads = await client.execute(
      "SELECT id, resourceId, metadata, createdAt, updatedAt FROM mastra_threads ORDER BY id",
    );
    const documents = await client.execute(
      "SELECT id, resource_id, created_at, updated_at FROM documents ORDER BY id",
    );
    const derivatives = await client.execute(
      "SELECT doc_id, generated_at, created_at, updated_at FROM document_derivatives",
    );

    expect(threads.rows).toHaveLength(2);
    expect(documents.rows).toHaveLength(2);
    expect(derivatives.rows).toHaveLength(1);
    expect(threads.rows[1]).toMatchObject({
      id: "thread-one",
      resourceId: "qingagent-user",
      createdAt: "2025-04-16T01:00:00.000Z",
      updatedAt: "2025-04-16T01:00:00.000Z",
    });
    expect(Buffer.from(threads.rows[1]!.metadata as unknown as Uint8Array).toString()).toBe(
      "thread-meta",
    );
    expect(documents.rows).toEqual([
      expect.objectContaining({
        id: "doc-derived",
        resource_id: "qingagent-user",
        created_at: "2025-04-16T01:00:00.000Z",
        updated_at: "2025-04-16T01:00:00.000Z",
      }),
      expect.objectContaining({
        id: "doc-main",
        resource_id: "qingagent-user",
        created_at: "2025-04-16T01:00:00.000Z",
        updated_at: "2025-04-16T01:00:00.000Z",
      }),
    ]);
    expect(derivatives.rows[0]).toMatchObject({
      doc_id: "doc-derived",
      generated_at: "2025-04-16T01:00:00.000Z",
      created_at: "2025-04-16T01:00:00.000Z",
      updated_at: "2025-04-16T01:00:00.000Z",
    });
    await expect(
      import("node:fs/promises").then(({ readFile }) =>
        readFile(join(process.env.QINGAGENT_UPLOADS_DIR!, "asset-1", "source.png"), "utf8")
      ),
    ).resolves.toBe("fixture-image");
    await expect(getAppSetting("seed_briefing:thread-one")).resolves.toBe(
      "公共简报\n\n单篇简报",
    );

    const { qingagentAgent } = await import("../agents/qingagent.js");
    const seededInstructions = await qingagentAgent.getInstructions({
      requestContext: new RequestContext([["sessionId", "thread-one"]]),
    });
    const ordinaryInstructions = await qingagentAgent.getInstructions({
      requestContext: new RequestContext([["sessionId", "ordinary-thread"]]),
    });
    expect(seededInstructions).toContain("系统·预置示例会话补充上下文（仅模型可见）");
    expect(seededInstructions).toContain("公共简报\n\n单篇简报");
    expect(ordinaryInstructions).not.toContain("系统·预置示例会话补充上下文");
  });
});
