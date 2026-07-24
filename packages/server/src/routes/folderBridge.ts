import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { requestClientAddress, sseAdmission } from "../lib/sseAdmission";
import {
  browserFolderSourcesEnabled,
  getBrowserFolderBridgeClientFolderIds,
  getBrowserFolderBridgePendingRequest,
  isBrowserFolderBridgeClientRegistered,
  isBrowserFolderSourceRegistered,
  openBrowserFolderBridgeConnection,
  registerBrowserFolderSource,
  resolveBrowserFolderBridgeResponse,
  unregisterBrowserFolderSource,
  type BrowserFolderBridgeBoundResponse,
  type BrowserFolderBridgeEntry,
  type BrowserFolderBridgeResponse,
  type BrowserFolderBridgeStat,
} from "@qingagent/core";
import { z } from "zod";
import { requireTrustedOrigin } from "../lib/trustedOrigin";
import { parseBody } from "../lib/validation";
import { refreshBrowserFolderSourceFileCountsForBridgeConnection } from "../gateway/bridgeHandler";

const HEADER_SESSION_ID = "x-qingagent-session-id";
const HEADER_FOLDER_ID = "x-qingagent-folder-id";
const HEADER_CLIENT_ID = "x-qingagent-client-id";
const HEADER_OP = "x-qingagent-folder-op";

export const folderBridgeRoutes = new Hono();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requireBrowserBridgeEnabled(c: Context): Response | null {
  if (browserFolderSourcesEnabled()) return null;
  return c.json({ error: "browser folder sources are disabled" }, 403);
}

function badRequest(c: Context, error: string): Response {
  return c.json({ error }, 400);
}

function responseTooLarge(c: Context, error: string): Response {
  return c.json({ error }, 413);
}

function parseContentLength(value: string | undefined): number | null {
  if (value === undefined) return null;
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 0) return null;
  return length;
}

function bindingMatchesRequest(
  request: { sessionId: string; folderId: string; clientId: string },
  bound: { sessionId: string; folderId: string; clientId: string },
): boolean {
  return (
    request.sessionId === bound.sessionId &&
    request.folderId === bound.folderId &&
    request.clientId === bound.clientId
  );
}

function validateRegistrationBody(value: unknown): {
  sessionId: string;
  folderId: string;
  clientId: string;
} | null {
  if (!isRecord(value)) return null;
  if (!nonEmptyString(value.sessionId)) return null;
  if (!nonEmptyString(value.folderId)) return null;
  if (!nonEmptyString(value.clientId)) return null;
  return {
    sessionId: value.sessionId,
    folderId: value.folderId,
    clientId: value.clientId,
  };
}

function validateStat(value: unknown): BrowserFolderBridgeStat | null {
  if (!isRecord(value)) return null;
  if (!nonEmptyString(value.name)) return null;
  if (value.type !== "file" && value.type !== "directory") return null;
  if (typeof value.size !== "number" || !Number.isFinite(value.size) || value.size < 0) return null;
  if (!nonEmptyString(value.createdAt)) return null;
  if (!nonEmptyString(value.modifiedAt)) return null;
  if (value.mimeType !== undefined && typeof value.mimeType !== "string") return null;
  return {
    name: value.name,
    type: value.type,
    size: value.size,
    createdAt: value.createdAt,
    modifiedAt: value.modifiedAt,
    ...(value.mimeType ? { mimeType: value.mimeType } : {}),
  };
}

function validateEntries(value: unknown): BrowserFolderBridgeEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: BrowserFolderBridgeEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    if (!nonEmptyString(item.name)) return null;
    if (item.type !== "file" && item.type !== "directory") return null;
    if (
      item.size !== undefined &&
      (typeof item.size !== "number" || !Number.isFinite(item.size) || item.size < 0)
    ) {
      return null;
    }
    entries.push({
      name: item.name,
      type: item.type,
      ...(typeof item.size === "number" ? { size: item.size } : {}),
    });
  }
  return entries;
}

function validateJsonResponse(value: unknown): BrowserFolderBridgeBoundResponse | null {
  if (!isRecord(value)) return null;
  if (!nonEmptyString(value.sessionId)) return null;
  if (!nonEmptyString(value.folderId)) return null;
  if (!nonEmptyString(value.clientId)) return null;
  let response: BrowserFolderBridgeResponse | null = null;
  if (value.ok === false) {
    response = { ok: false, error: nonEmptyString(value.error) ? value.error : "browser bridge request failed" };
  } else if (value.ok === true && value.op === "stat") {
    const stat = validateStat(value.stat);
    if (!stat) return null;
    response = { ok: true, op: "stat", stat };
  } else if (value.ok === true && value.op === "readdir") {
    const entries = validateEntries(value.entries);
    if (!entries) return null;
    response = { ok: true, op: "readdir", entries };
  }
  if (!response) return null;
  return {
    sessionId: value.sessionId,
    folderId: value.folderId,
    clientId: value.clientId,
    response,
  };
}

folderBridgeRoutes.post("/folder-bridge/register", async (c) => {
  const disabled = requireBrowserBridgeEnabled(c);
  if (disabled) return disabled;
  const originError = requireTrustedOrigin(c);
  if (originError) return originError;

  const parsed = await parseBody(c, z.unknown(), {
    makeErrorResponse: (ctx) => badRequest(ctx, "Invalid JSON body"),
  });
  if (!parsed.ok) return parsed.response;
  const registration = validateRegistrationBody(parsed.data);
  if (!registration) return badRequest(c, "Invalid folder bridge registration");
  const registered = registerBrowserFolderSource(
    registration.sessionId,
    registration.folderId,
    registration.clientId,
  );
  if (!registered) return c.json({ error: "browser folder source was detached" }, 409);
  return c.json({ ok: true });
});

folderBridgeRoutes.post("/folder-bridge/unregister", async (c) => {
  const disabled = requireBrowserBridgeEnabled(c);
  if (disabled) return disabled;
  const originError = requireTrustedOrigin(c);
  if (originError) return originError;

  const parsed = await parseBody(c, z.unknown(), {
    makeErrorResponse: (ctx) => badRequest(ctx, "Invalid JSON body"),
  });
  if (!parsed.ok) return parsed.response;
  const registration = validateRegistrationBody(parsed.data);
  if (!registration) return badRequest(c, "Invalid folder bridge registration");
  const unregistered = unregisterBrowserFolderSource(
    registration.sessionId,
    registration.folderId,
    registration.clientId,
  );
  if (!unregistered) return c.json({ error: "folder bridge binding is not current" }, 409);
  return c.json({ ok: true });
});

folderBridgeRoutes.get("/folder-bridge/events", (c) => {
  const disabled = requireBrowserBridgeEnabled(c);
  if (disabled) return disabled;
  const originError = requireTrustedOrigin(c);
  if (originError) return originError;

  const sessionId = c.req.query("sessionId");
  const clientId = c.req.query("clientId");
  if (!nonEmptyString(sessionId) || !nonEmptyString(clientId)) {
    return badRequest(c, "sessionId and clientId are required");
  }
  if (!isBrowserFolderBridgeClientRegistered(sessionId, clientId)) {
    return c.json({ error: "folder bridge client is not registered" }, 404);
  }
  const client = requestClientAddress(c);
  const admission = sseAdmission.acquire(client.ip, sessionId, { loopback: client.loopback });
  if (!admission.accepted) {
    c.header("Retry-After", "1");
    return c.json({ error: "SSE connection limit exceeded", limit: admission.reason }, 429);
  }

  return streamSSE(c, async (stream) => {
    let closeConnection: () => void = () => undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      await stream.writeSSE({ event: "ready", data: "{}" });
      closeConnection = openBrowserFolderBridgeConnection({
        sessionId,
        clientId,
        send: (request) =>
          stream.writeSSE({
            event: "folder-request",
            data: JSON.stringify(request),
          }),
      });
      refreshBrowserFolderSourceFileCountsForBridgeConnection(
        sessionId,
        clientId,
        getBrowserFolderBridgeClientFolderIds(sessionId, clientId),
      );

      await new Promise<void>((resolve) => {
        heartbeat = setInterval(() => {
          void stream.writeSSE({ event: "ping", data: "{}" }).catch(() => undefined);
        }, 15_000);
        stream.onAbort(resolve);
      });
    } finally {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      closeConnection();
      admission.release();
    }
  });
});

folderBridgeRoutes.post("/folder-bridge/responses/:requestId", async (c) => {
  const disabled = requireBrowserBridgeEnabled(c);
  if (disabled) return disabled;
  const originError = requireTrustedOrigin(c);
  if (originError) return originError;

  const requestId = c.req.param("requestId");
  if (!nonEmptyString(requestId)) return badRequest(c, "requestId is required");
  const pendingRequest = getBrowserFolderBridgePendingRequest(requestId);
  if (!pendingRequest) return c.json({ error: "request not found or binding mismatch" }, 404);

  const contentType = c.req.header("content-type") ?? "";
  let bound: BrowserFolderBridgeBoundResponse | null = null;
  if (contentType.includes("application/octet-stream")) {
    const sessionId = c.req.header(HEADER_SESSION_ID);
    const folderId = c.req.header(HEADER_FOLDER_ID);
    const clientId = c.req.header(HEADER_CLIENT_ID);
    const op = c.req.header(HEADER_OP);
    if (
      !nonEmptyString(sessionId) ||
      !nonEmptyString(folderId) ||
      !nonEmptyString(clientId) ||
      op !== "readFile"
    ) {
      return badRequest(c, "Invalid binary folder bridge response headers");
    }
    const binding = { sessionId, folderId, clientId };
    if (!bindingMatchesRequest(pendingRequest, binding)) {
      return c.json({ error: "request not found or binding mismatch" }, 404);
    }
    if (!isBrowserFolderSourceRegistered(sessionId, folderId, clientId)) {
      return c.json({ error: "folder bridge client is not registered" }, 404);
    }
    if (pendingRequest.op !== "readFile") {
      return badRequest(c, "Binary folder bridge response is only valid for readFile");
    }
    const maxBytes = pendingRequest.maxBytes;
    const contentLength = parseContentLength(c.req.header("content-length"));
    if (typeof maxBytes === "number" && contentLength !== null && contentLength > maxBytes) {
      resolveBrowserFolderBridgeResponse(requestId, {
        sessionId,
        folderId,
        clientId,
        response: { ok: false, error: "readFile response exceeds maxBytes" },
      });
      return responseTooLarge(c, "readFile response exceeds maxBytes");
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (typeof maxBytes === "number" && bytes.byteLength > maxBytes) {
      resolveBrowserFolderBridgeResponse(requestId, {
        sessionId,
        folderId,
        clientId,
        response: { ok: false, error: "readFile response exceeds maxBytes" },
      });
      return responseTooLarge(c, "readFile response exceeds maxBytes");
    }
    bound = {
      sessionId,
      folderId,
      clientId,
      response: {
        ok: true,
        op: "readFile",
        bytes,
      },
    };
  } else {
    const parsed = await parseBody(c, z.unknown(), {
      makeErrorResponse: (ctx) => badRequest(ctx, "Invalid JSON body"),
    });
    if (!parsed.ok) return parsed.response;
    bound = validateJsonResponse(parsed.data);
    if (!bound) return badRequest(c, "Invalid folder bridge response");
    if (!bindingMatchesRequest(pendingRequest, bound)) {
      return c.json({ error: "request not found or binding mismatch" }, 404);
    }
    if (!isBrowserFolderSourceRegistered(bound.sessionId, bound.folderId, bound.clientId)) {
      return c.json({ error: "folder bridge client is not registered" }, 404);
    }
  }

  const accepted = resolveBrowserFolderBridgeResponse(requestId, bound);
  if (!accepted) return c.json({ error: "request not found or binding mismatch" }, 404);
  return c.json({ ok: true });
});
