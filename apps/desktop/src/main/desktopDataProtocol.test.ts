import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ATTACH_CAPABILITY_NAMES,
  ATTACH_MODEL_OVERRIDE_HEADERS,
  type AttachCapabilities,
} from "@qingagent/contract-ts";
import type { BackendConnection, BackendConnectionListener } from "./backendConnection.js";
import type { BackendConnectionSnapshot } from "../backendConnectionContract.js";
import {
  createDesktopDataProtocolHandler,
  DESKTOP_DATA_ORIGIN,
  isAttachDataRoute,
} from "./desktopDataProtocol.js";

function allCapabilities(value: boolean): AttachCapabilities {
  return Object.fromEntries(ATTACH_CAPABILITY_NAMES.map((name) => [name, value])) as AttachCapabilities;
}

function backend(
  mode: "embedded" | "attach",
  forwardDataRequest: (request: Request) => Promise<Response>,
): BackendConnection {
  const snapshot: BackendConnectionSnapshot = {
    mode,
    status: "attached",
    generation: 0,
    libraryId: "00000000-0000-4000-8000-000000000001",
    instanceId: "00000000-0000-4000-8000-000000000002",
    effectiveCapabilities: allCapabilities(mode === "embedded"),
    errorCode: null,
    conflictKind: null,
  };
  return {
    mode,
    snapshot: () => snapshot,
    subscribe: (_listener: BackendConnectionListener) => () => {},
    forwardDataRequest,
    probe: async () => true,
    resolveQingjianSession: async () => "found",
    retry: async () => {},
    dispose: () => {},
  };
}

test("预检只接受壳 origin、精确 route 和无凭据头白名单", async () => {
  const handler = createDesktopDataProtocolHandler(backend("attach", async () => {
    throw new Error("预检不应转发");
  }));
  const allowed = await handler(new Request(`${DESKTOP_DATA_ORIGIN}/api/v1/commands`, {
    method: "OPTIONS",
    headers: {
      Origin: "qingagent://app",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type, x-client-trace-id",
    },
  }));
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "qingagent://app");
  assert.equal(allowed.headers.get("access-control-allow-methods"), "POST");
  assert.equal(
    allowed.headers.get("vary"),
    "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
  );

  for (const deniedHeader of ["authorization", "cookie", "x-model-key", "x-vision-key"]) {
    const denied = await handler(new Request(`${DESKTOP_DATA_ORIGIN}/api/v1/commands`, {
      method: "OPTIONS",
      headers: {
        Origin: "qingagent://app",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": deniedHeader,
      },
    }));
    assert.equal(denied.status, 403, deniedHeader);
  }
});

test("attach 未登记 route 在主进程默认拒绝", async () => {
  let forwarded = false;
  const handler = createDesktopDataProtocolHandler(backend("attach", async () => {
    forwarded = true;
    return Response.json({ ok: true });
  }));
  const response = await handler(new Request(`${DESKTOP_DATA_ORIGIN}/api/v1/settings/model/test-custom`, {
    method: "POST",
  }));
  assert.equal(response.status, 403);
  assert.equal(forwarded, false);
});

test("attach 放行 usage/clientlog，但会话删除继续由 data 层 fail closed", () => {
  assert.equal(isAttachDataRoute("GET", "/api/v1/usage/summary"), true);
  assert.equal(isAttachDataRoute("GET", "/api/v1/usage/docstats"), true);
  assert.equal(isAttachDataRoute("POST", "/api/v1/clientlog"), true);
  assert.equal(isAttachDataRoute("DELETE", "/api/v1/sessions/session-1"), false);
});

test("实际请求拒绝非壳 origin，未携 Origin 的资源加载仍可用", async () => {
  let forwarded = 0;
  const handler = createDesktopDataProtocolHandler(backend("attach", async () => {
    forwarded += 1;
    return Response.json({ ok: true });
  }));
  const denied = await handler(new Request(`${DESKTOP_DATA_ORIGIN}/api/v1/home`, {
    headers: { Origin: "https://evil.example" },
  }));
  assert.equal(denied.status, 403);
  assert.equal(forwarded, 0);

  const allowed = await handler(new Request(`${DESKTOP_DATA_ORIGIN}/api/v1/home`));
  assert.equal(allowed.status, 200);
  assert.equal(forwarded, 1);
});

test("dev renderer origin 与打包壳 origin 互斥且响应回显实际允许 origin", async () => {
  let forwarded = 0;
  const devOrigin = "http://localhost:6173";
  const handler = createDesktopDataProtocolHandler(backend("attach", async () => {
    forwarded += 1;
    return Response.json({ ok: true });
  }), devOrigin);
  const allowed = await handler(new Request(`${DESKTOP_DATA_ORIGIN}/api/v1/home`, {
    headers: { Origin: devOrigin },
  }));
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), devOrigin);
  const packagedOrigin = await handler(new Request(`${DESKTOP_DATA_ORIGIN}/api/v1/home`, {
    headers: { Origin: "qingagent://app" },
  }));
  assert.equal(packagedOrigin.status, 403);
  assert.equal(forwarded, 1);
});

test("上游 3xx 转受控错误并删除 Location", async () => {
  const handler = createDesktopDataProtocolHandler(backend("attach", async () => new Response(null, {
    status: 302,
    headers: { Location: "https://evil.example/" },
  })));
  const response = await handler(new Request(`${DESKTOP_DATA_ORIGIN}/api/v1/home`));
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("location"), null);
});

test("主动内容 MIME 被强制附件且响应不暴露上游 CORS/cookie", async () => {
  const handler = createDesktopDataProtocolHandler(backend("attach", async () => new Response(
    "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
    {
      headers: {
        "Content-Type": "image/svg+xml",
        "Set-Cookie": "secret=1",
        "Access-Control-Allow-Origin": "*",
      },
    },
  )));
  const response = await handler(new Request(
    `${DESKTOP_DATA_ORIGIN}/api/v1/files/00000000-0000-4000-8000-000000000001/payload.svg`,
  ));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("content-disposition"), "attachment");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("access-control-allow-origin"), "qingagent://app");
  assert.equal(response.headers.get("vary"), "Origin");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy") ?? "", /sandbox/);
});

test("embedded 数据 origin 仍保留原有 API 与遥测中继", async () => {
  const seen: string[] = [];
  const handler = createDesktopDataProtocolHandler(backend("embedded", async (request) => {
    seen.push(new URL(request.url).pathname);
    return Response.json({ ok: true });
  }));
  assert.equal((await handler(new Request(`${DESKTOP_DATA_ORIGIN}/api/v1/home`))).status, 200);
  assert.equal((await handler(new Request(`${DESKTOP_DATA_ORIGIN}/__telemetry/send`, {
    method: "POST",
  }))).status, 200);
  assert.deepEqual(seen, ["/api/v1/home", "/__telemetry/send"]);
});

test("embedded 跨 origin 兼容既有认证/模型头与 Set-Cookie", async () => {
  const handler = createDesktopDataProtocolHandler(backend("embedded", async () => new Response(
    JSON.stringify({ ok: true }),
    {
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": "qa_auth=secret; HttpOnly; Path=/api; SameSite=Lax",
      },
    },
  )));
  const requestedHeaders = ["authorization", ...ATTACH_MODEL_OVERRIDE_HEADERS].join(", ");
  const preflight = await handler(new Request(`${DESKTOP_DATA_ORIGIN}/api/v1/commands`, {
    method: "OPTIONS",
    headers: {
      Origin: "qingagent://app",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": requestedHeaders,
    },
  }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
  assert.equal(preflight.headers.get("access-control-allow-headers"), requestedHeaders);

  const response = await handler(new Request(`${DESKTOP_DATA_ORIGIN}/api/v1/auth/session`, {
    method: "POST",
    headers: { Origin: "qingagent://app", "Content-Type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") ?? "", /qa_auth=secret/);
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
});
