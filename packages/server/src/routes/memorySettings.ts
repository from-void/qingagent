import { Hono } from "hono";
import { z } from "zod";
import type {
  MemorySettingsResponse,
  UpdateMemorySettingsRequest,
} from "@qingagent/contract-ts";
import {
  normalizeWorkingMemoryContent,
  QINGAGENT_RESOURCE_ID,
  QINGAGENT_WORKING_MEMORY_MAX_CHARS,
  readWorkingMemoryContent,
  WorkingMemoryContentError,
  withWorkingMemoryWriteLock,
  writeWorkingMemoryContent,
} from "@qingagent/core";
import { requireTrustedOrigin } from "../lib/trustedOrigin";

const updateMemorySettingsSchema = z.object({
  content: z.string(),
  baseContent: z.string(),
}).strict();

interface MemorySettingsRoutesDependencies {
  readContent?: () => Promise<string>;
  writeContent?: (content: string) => Promise<string>;
}

function responseFor(content: string): MemorySettingsResponse {
  return {
    content,
    exists: content.length > 0,
    maxChars: QINGAGENT_WORKING_MEMORY_MAX_CHARS,
  };
}

async function parseUpdateBody(
  request: Request,
): Promise<{ ok: true; value: UpdateMemorySettingsRequest } | { ok: false }> {
  try {
    const parsed = updateMemorySettingsSchema.safeParse(await request.json());
    if (!parsed.success) return { ok: false };
    return { ok: true, value: parsed.data };
  } catch {
    return { ok: false };
  }
}

export function createMemorySettingsRoutes(
  dependencies: MemorySettingsRoutesDependencies = {},
): Hono {
  const routes = new Hono();
  const target = {
    resourceId: QINGAGENT_RESOURCE_ID,
    threadId: QINGAGENT_RESOURCE_ID,
  };
  const readContent = dependencies.readContent ??
    (() => readWorkingMemoryContent(target));
  const writeContent = dependencies.writeContent ??
    ((content: string) => writeWorkingMemoryContent(target, content));

  routes.get("/settings/memory", async (c) => {
    const rejected = requireTrustedOrigin(c);
    if (rejected) return rejected;
    const content = await readContent();
    return c.json(responseFor(content));
  });

  routes.put("/settings/memory", async (c) => {
    const rejected = requireTrustedOrigin(c);
    if (rejected) return rejected;

    const parsed = await parseUpdateBody(c.req.raw);
    if (!parsed.ok) {
      return c.json({ error: "请求格式不正确，请检查后重试。" }, 400);
    }

    return withWorkingMemoryWriteLock(target, async () => {
      const current = normalizeWorkingMemoryContent(await readContent());
      const baseContent = normalizeWorkingMemoryContent(parsed.value.baseContent);
      if (current !== baseContent) {
        return c.json({ error: "记忆已被更新，请刷新后再改。" }, 409);
      }

      try {
        const saved = await writeContent(parsed.value.content);
        return c.json(responseFor(saved));
      } catch (error) {
        if (error instanceof WorkingMemoryContentError && error.code === "too_long") {
          return c.json({ error: error.message }, 400);
        }
        throw error;
      }
    });
  });

  return routes;
}

export const memorySettingsRoutes = createMemorySettingsRoutes();
