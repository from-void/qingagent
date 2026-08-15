import { Hono } from "hono";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import {
  ATTACH_CAPABILITY_NAMES,
  ATTACH_PROTOCOL_VERSION,
  type AttachCapabilities,
  type AttachHandshakeResponse,
} from "@qingagent/contract-ts";
import { createAttachSession } from "../lib/attachSessions";
import { getExternalInstancePublicInfo } from "../lib/externalInstance";
import { parseBody } from "../lib/validation";

const capabilitiesShape = Object.fromEntries(
  ATTACH_CAPABILITY_NAMES.map((name) => [name, z.boolean()]),
) as Record<(typeof ATTACH_CAPABILITY_NAMES)[number], z.ZodBoolean>;

const attachHandshakeSchema = z.object({
  desktopCapabilities: z.object(capabilitiesShape).strict(),
}).strict();

export const attachRoutes = new Hono();

attachRoutes.post(
  "/attach/handshake",
  bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => c.json({ error: "请求体过大" }, 413),
  }),
  async (c) => {
  const identity = getExternalInstancePublicInfo();
  if (!identity || identity.attachProtocolVersion !== ATTACH_PROTOCOL_VERSION) {
    return c.json({ error: { code: "INSTANCE_NOT_READY", message: "后台尚未准备好" } }, 503);
  }
  const parsed = await parseBody(c, attachHandshakeSchema);
  if (!parsed.ok) return parsed.response;
  const desktopCapabilities = parsed.data.desktopCapabilities as AttachCapabilities;
  const { token, session } = createAttachSession({ identity, desktopCapabilities });
  const response: AttachHandshakeResponse = {
    ...identity,
    attachSessionToken: token,
    absoluteExpiresAt: new Date(session.absoluteExpiresAtMs).toISOString(),
    idleExpiresAt: new Date(session.idleExpiresAtMs).toISOString(),
    serverCapabilities: { ...session.serverCapabilities },
    effectiveCapabilities: { ...session.effectiveCapabilities },
  };
  c.header("Cache-Control", "no-store");
  return c.json(response);
  },
);
