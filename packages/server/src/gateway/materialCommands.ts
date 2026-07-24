import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import { readFile } from "node:fs/promises";
import {
  findMaterialByFileId,
  parseFileBuffer,
  resolveFileIds,
  schedulePersist,
  upsertMaterialByFileId,
  type Material,
  type SessionState,
} from "./bridgeCore";
import { deleteUploadedFile } from "../lib/uploadStorage";
import { bindClientTraceId } from "./commandTracing";
import type { CommandExecutionContext } from "./commandTypes";
import { getOrRestoreSession } from "./sessionLifecycle";

function materialCommandBusyFrame(session: SessionState): BridgeFrame {
  return {
    kind: "stream",
    data: {
      kind: "draftingFailed",
      data: {
        streamId: session.streamId ?? "blocked",
        reason: "生成中，请稍后再试",
        retriable: false,
      },
    },
  };
}

function materialResourceUpdatedFrame(mat: Material): BridgeFrame {
  const metadataWithFileId = { ...mat.metadata, fileId: mat.fileId };
  return {
    kind: "resourceUpdated",
    data: {
      resourceRef: { id: mat.id, domain: { kind: "file" } },
      summary: mat.summary,
      metadata: metadataWithFileId,
    },
  };
}

function clearExtractedTextCacheForMaterial(
  session: SessionState,
  mat: Material,
  materialId?: string,
): void {
  const keys = [mat.filename, mat.metadata.title, mat.metadata.sourceUrl].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (typeof materialId === "string" && materialId.length > 0) {
    keys.push(materialId);
  }
  for (const key of keys) {
    session._extractedTexts?.delete(key);
  }
}

function cacheExtractedTextForMaterial(
  session: SessionState,
  mat: Material,
  materialId?: string,
): void {
  if (mat.metadata.parseState !== "ready" || mat.text.trim().length === 0) return;
  session._extractedTexts ??= new Map();
  const entry = { text: mat.text, sourceUrl: mat.metadata.sourceUrl ?? null, fileId: mat.fileId };
  session._extractedTexts.set(mat.filename, entry);
  if (typeof mat.metadata.title === "string" && mat.metadata.title.length > 0) {
    session._extractedTexts.set(mat.metadata.title, entry);
  }
  if (typeof materialId === "string" && materialId.length > 0) {
    session._extractedTexts.set(materialId, entry);
  }
}

type MaterialCommand = Extract<Command, {
  kind: "updateMaterialSummary" | "removeMaterial" | "reparseMaterial";
}>;

export async function* handleMaterialCommand(
  command: MaterialCommand,
  context: CommandExecutionContext,
): AsyncGenerator<BridgeFrame> {
  const { resolvedClientTraceId, origin, modelOverrides } = context;
  switch (command.kind) {
    case "updateMaterialSummary": {
      const session = await getOrRestoreSession(command.data.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${command.data.sessionId}`);
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);

      if (session.streamId || session.runId) {
        yield materialCommandBusyFrame(session);
        return;
      }

      const mat = session.materials.get(command.data.materialId);
      if (!mat) return;

      mat.summary = command.data.summary;
      mat.updatedAt = new Date().toISOString();

      yield materialResourceUpdatedFrame(mat);
      await schedulePersist(session, "command:updateMaterialSummary");
      return;
    }

    case "removeMaterial": {
      const session = await getOrRestoreSession(command.data.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${command.data.sessionId}`);
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);

      if (session.streamId || session.runId) {
        yield materialCommandBusyFrame(session);
        return;
      }

      const mat = session.materials.get(command.data.materialId);
      if (!mat) return;

      session.materials.delete(command.data.materialId);
      clearExtractedTextCacheForMaterial(session, mat, command.data.materialId);

      const fileId = mat.fileId;
      if (fileId) {
        const stillShared = Array.from(session.materials.values()).some(
          (candidate) => candidate.fileId === fileId,
        );
        if (!stillShared) {
          await deleteUploadedFile(fileId);
        }
      }

      yield {
        kind: "resourceRemoved",
        data: {
          resourceRef: { id: command.data.materialId, domain: { kind: "file" } },
        },
      };
      await schedulePersist(session, "command:removeMaterial");
      return;
    }

    case "reparseMaterial": {
      const session = await getOrRestoreSession(command.data.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${command.data.sessionId}`);
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);

      if (session.streamId || session.runId) {
        console.info("[materials] reparseMaterial busy", {
          sessionId: session.sessionId,
          fileId: command.data.fileId,
          streamId: session.streamId,
          runId: session.runId,
        });
        yield materialCommandBusyFrame(session);
        return;
      }

      const fileId = command.data.fileId;
      const existing = findMaterialByFileId(session, fileId);
      const [resolved] = await resolveFileIds([fileId]);
      const filename = existing?.filename || resolved?.filename || fileId;
      const mimeType = existing?.mimeType || resolved?.mimeType || "application/octet-stream";

      if (existing) {
        clearExtractedTextCacheForMaterial(session, existing, existing.id);
      }

      if (!resolved) {
        console.warn("[materials] reparseMaterial missing upload", {
          sessionId: session.sessionId,
          fileId,
        });
        const { frame } = upsertMaterialByFileId(
          session,
          { fileId, filename, mimeType },
          {
            kind: "error",
            message: "原始文件不存在，无法重试解析",
            parseError: "原始文件不存在，无法重试解析",
          },
        );
        yield frame;
        await schedulePersist(session, "command:reparseMaterial");
        return;
      }

      let buffer: Buffer;
      try {
        buffer = await readFile(resolved.filePath, {
          signal: context.commandAbortSignal,
        });
      } catch (error) {
        if (context.commandAbortSignal?.aborted) throw error;
        console.warn("[materials] reparseMaterial read upload failed", {
          sessionId: session.sessionId,
          fileId,
          filename,
        });
        const { frame } = upsertMaterialByFileId(
          session,
          { fileId, filename, mimeType },
          {
            kind: "error",
            message: "原始文件不存在，无法重试解析",
            parseError: "原始文件不存在，无法重试解析",
          },
        );
        yield frame;
        await schedulePersist(session, "command:reparseMaterial");
        return;
      }

      const parseStartedAt = Date.now();
      console.info("[materials] reparseMaterial parse start", {
        sessionId: session.sessionId,
        fileId,
        filename,
        mimeType,
        size: buffer.length,
      });
      const parseResult = await parseFileBuffer({
        buffer,
        filename,
        mimeType,
        signal: context.commandAbortSignal,
      });
      const { material, frame } = upsertMaterialByFileId(
        session,
        { fileId, filename, mimeType },
        parseResult,
      );
      cacheExtractedTextForMaterial(session, material, material.id);

      console.info("[materials] reparseMaterial parse end", {
        sessionId: session.sessionId,
        fileId,
        materialId: material.id,
        ok: parseResult.ok,
        failureKind: parseResult.ok ? null : parseResult.failureKind,
        textLength: parseResult.ok ? parseResult.text.length : 0,
        durationMs: Date.now() - parseStartedAt,
      });
      yield frame;
      await schedulePersist(session, "command:reparseMaterial");
      return;
    }
  }
}
