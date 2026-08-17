import { afterAll, describe, expect, it } from "vitest";
import {
  ATTACH_DATA_ROUTE_TEMPLATES,
  type AttachCapabilities,
  type AttachIdentity,
} from "@qingagent/contract-ts";
import { COMMAND_KINDS } from "@qingagent/contract-ts/schemas";
import { app } from "../app";
import {
  ATTACH_COMMAND_OPERATION_POLICY,
  ATTACH_ROUTE_POLICY,
  SERVER_ROUTE_CATALOG,
  routeAuthorizationDecision,
} from "../lib/attachPolicy";
import { createAttachSession, revokeAllAttachSessions } from "../lib/attachSessions";
import type { RequestPrincipal } from "../lib/principal";

const capabilities = Object.fromEntries([
  "folderSelection", "confirmGrant", "diagnosticsExport", "documentExport", "sessionDeletion",
  "credentialProvider", "modelKeys", "skillMutation", "connectors", "updates",
  "templateMutation", "derivativeMutation", "lexiconMutation", "deepLink",
  "docEditing", "review", "assets",
].map((name) => [name, true])) as AttachCapabilities;

const identity: AttachIdentity = {
  schemaVersion: 2,
  port: 34567,
  pid: 1,
  version: "test",
  attachProtocolVersion: 1,
  instanceId: "instance-policy",
  libraryId: "00000000-0000-4000-8000-000000000001",
  startedAt: "2026-08-16T00:00:00.000Z",
};

afterAll(() => revokeAllAttachSessions());

function routeKey(method: string, path: string): string {
  return `${method} ${path}`;
}

function samplePath(template: string): string {
  return template.replace(/:filename\b/g, "example.txt").replace(/:[^/]+/g, "sample-id");
}

type ExpectedRouteClass = "legacy" | "handshake" | "external";

/** 独立于生产策略实现的固化预期；新增 endpoint 必须在此显式分类。 */
const EXPECTED_ROUTE_CLASSES = [
  ["legacy", "GET", "/health"],
  ["legacy", "POST", "/api/v1/auth/session"],
  ["handshake", "POST", "/api/v1/attach/handshake"],
  ["legacy", "GET", "/api/v1/home"],
  ["legacy", "DELETE", "/api/v1/sessions/:id"],
  ["legacy", "GET", "/api/v1/history"],
  ["legacy", "GET", "/api/v1/history/:versionId"],
  ["legacy", "POST", "/api/v1/commands"],
  ["legacy", "GET", "/api/v1/events"],
  ["legacy", "POST", "/api/v1/commit"],
  ["legacy", "POST", "/api/v1/confirms/cancel"],
  ["legacy", "POST", "/api/v1/confirms/decision"],
  ["legacy", "GET", "/api/v1/settings/security"],
  ["legacy", "POST", "/api/v1/settings/security/bypass"],
  ["legacy", "POST", "/api/v1/settings/security/:kind"],
  ["legacy", "GET", "/api/v1/settings/memory"],
  ["legacy", "PUT", "/api/v1/settings/memory"],
  ["legacy", "GET", "/api/v1/settings/onboarding"],
  ["legacy", "PUT", "/api/v1/settings/onboarding"],
  ["legacy", "PUT", "/api/v1/settings/onboarding/coach/:id"],
  ["legacy", "GET", "/api/v1/settings/credential-share"],
  ["legacy", "POST", "/api/v1/settings/credential-share"],
  ["legacy", "POST", "/api/v1/upload"],
  ["legacy", "GET", "/api/v1/files/:fileId"],
  ["legacy", "GET", "/api/v1/files/:fileId/:filename"],
  ["legacy", "GET", "/api/v1/materials/:materialId/text"],
  ["legacy", "POST", "/api/v1/ask-more"],
  ["legacy", "GET", "/api/v1/export/:sessionId"],
  ["legacy", "GET", "/api/v1/skills"],
  ["legacy", "GET", "/api/v1/skills/:name"],
  ["legacy", "POST", "/api/v1/skills/install"],
  ["legacy", "POST", "/api/v1/skills/:name/:action"],
  ["legacy", "PATCH", "/api/v1/skills/:name"],
  ["legacy", "DELETE", "/api/v1/skills/:name"],
  ["legacy", "GET", "/api/v1/credentials"],
  ["legacy", "POST", "/api/v1/credentials"],
  ["legacy", "DELETE", "/api/v1/credentials/:platform"],
  ["legacy", "POST", "/api/v1/clientlog"],
  ["legacy", "GET", "/api/v1/debug/context"],
  ["legacy", "GET", "/api/v1/debug/skills"],
  ["legacy", "GET", "/api/v1/debug/skills/:name/raw"],
  ["legacy", "GET", "/api/v1/debug/tools"],
  ["legacy", "GET", "/api/v1/data/stats"],
  ["legacy", "GET", "/api/v1/data/sessions"],
  ["legacy", "GET", "/api/v1/data/usage/export"],
  ["legacy", "DELETE", "/api/v1/data/usage"],
  ["legacy", "POST", "/api/v1/folder-bridge/register"],
  ["legacy", "POST", "/api/v1/folder-bridge/unregister"],
  ["legacy", "GET", "/api/v1/folder-bridge/events"],
  ["legacy", "POST", "/api/v1/folder-bridge/responses/:requestId"],
  ["legacy", "GET", "/api/v1/settings/model"],
  ["legacy", "PUT", "/api/v1/settings/model"],
  ["legacy", "GET", "/api/v1/settings/model/balance"],
  ["legacy", "POST", "/api/v1/settings/model/test-custom"],
  ["legacy", "POST", "/api/v1/settings/vision/test"],
  ["legacy", "GET", "/api/v1/settings/search"],
  ["legacy", "GET", "/api/v1/settings/search/primary"],
  ["legacy", "PUT", "/api/v1/settings/search/primary"],
  ["legacy", "PUT", "/api/v1/settings/search/:id"],
  ["legacy", "POST", "/api/v1/settings/search/:id/test"],
  ["legacy", "GET", "/api/v1/usage/summary"],
  ["legacy", "GET", "/api/v1/usage/docstats"],
  ["legacy", "GET", "/api/v1/capabilities"],
  ["legacy", "GET", "/api/v1/connectors"],
  ["legacy", "GET", "/api/v1/connectors/:id"],
  ["legacy", "POST", "/api/v1/connectors/:id/start"],
  ["legacy", "POST", "/api/v1/connectors/:id/probe"],
  ["legacy", "DELETE", "/api/v1/connectors/:id/pending/:pendingId"],
  ["legacy", "DELETE", "/api/v1/connectors/:id"],
  ["legacy", "GET", "/api/v1/sessions/:sessionId/folder-sources/:folderId/entries"],
  ["legacy", "GET", "/api/v1/sessions/:sessionId/folder-sources/:folderId/file"],
  ["legacy", "GET", "/api/v1/diagnostics/usage"],
  ["legacy", "POST", "/api/v1/diagnostics/clear"],
  ["legacy", "POST", "/api/v1/diagnostics/export"],
  ["external", "GET", "/api/v1/external/review-templates"],
  ["external", "GET", "/api/v1/external/review-templates/:id"],
  ["external", "POST", "/api/v1/external/review-templates"],
  ["external", "PUT", "/api/v1/external/review-templates/:id"],
  ["external", "DELETE", "/api/v1/external/review-templates/:id"],
  ["external", "POST", "/api/v1/external/review-templates/:id/select"],
  ["external", "GET", "/api/v1/external/sessions/:id/review-supplement"],
  ["external", "PUT", "/api/v1/external/sessions/:id/review-supplement"],
  ["external", "POST", "/api/v1/external/sessions/:id/review/run"],
  ["external", "GET", "/api/v1/external/skills"],
  ["external", "GET", "/api/v1/external/skills/:name"],
  ["external", "POST", "/api/v1/external/skills"],
  ["external", "PUT", "/api/v1/external/skills/:name"],
  ["external", "DELETE", "/api/v1/external/skills/:name"],
  ["external", "POST", "/api/v1/external/skills/:name/:action"],
  ["external", "GET", "/api/v1/external/health"],
  ["external", "GET", "/api/v1/external/sessions"],
  ["external", "POST", "/api/v1/external/sessions"],
  ["external", "GET", "/api/v1/external/sessions/:id/doc"],
  ["external", "PUT", "/api/v1/external/sessions/:id/doc"],
  ["external", "GET", "/api/v1/external/sessions/:id/review"],
  ["external", "GET", "/api/v1/external/sessions/:id/review/patches/:patchId"],
  ["external", "GET", "/api/v1/external/sessions/:id/review/annotations/:annotationId"],
  ["external", "POST", "/api/v1/external/sessions/:id/review/verdicts"],
  ["external", "POST", "/api/v1/external/sessions/:id/review/commit"],
  ["external", "POST", "/api/v1/external/sessions/:id/review/annotations/ignore"],
  ["external", "GET", "/api/v1/external/sessions/:id/chat"],
  ["external", "POST", "/api/v1/external/sessions/:id/assets"],
  ["external", "GET", "/api/v1/external/sessions/:id/assets/:ref"],
  ["external", "GET", "/api/v1/external/sessions/:id/files"],
  ["external", "GET", "/api/v1/external/sessions/:id/files/:materialId/text"],
  ["external", "POST", "/api/v1/external/sessions/:id/proposals"],
  ["external", "POST", "/api/v1/external/sessions/:id/chat"],
  ["external", "GET", "/api/v1/external/sessions/:id/events"],
] as const satisfies readonly (readonly [ExpectedRouteClass, string, string])[];

/** 规格 §2 独立固化的 attach route 允许表，不从 ATTACH_ROUTE_POLICY 反推预期。 */
const EXPECTED_ATTACH_ROUTE_KEYS = new Set([
  "GET /api/v1/home",
  "GET /api/v1/history",
  "GET /api/v1/history/:versionId",
  "POST /api/v1/commands",
  "GET /api/v1/events",
  "POST /api/v1/commit",
  "POST /api/v1/ask-more",
  "POST /api/v1/confirms/cancel",
  "POST /api/v1/confirms/decision",
  "POST /api/v1/upload",
  "GET /api/v1/files/:fileId",
  "GET /api/v1/files/:fileId/:filename",
  "GET /api/v1/materials/:materialId/text",
  "GET /api/v1/export/:sessionId",
  "GET /api/v1/skills",
  "GET /api/v1/capabilities",
  "GET /api/v1/settings/security",
  "GET /api/v1/settings/memory",
  "GET /api/v1/settings/credential-share",
  "GET /api/v1/settings/model",
  "GET /api/v1/settings/model/balance",
  "GET /api/v1/settings/search",
  "GET /api/v1/settings/search/primary",
  "GET /api/v1/usage/summary",
  "GET /api/v1/usage/docstats",
  "POST /api/v1/clientlog",
]);

function matchesExpectedTemplate(pathname: string, template: string): boolean {
  const actual = pathname.split("/");
  const expected = template.split("/");
  return actual.length === expected.length && expected.every((part, index) =>
    part.startsWith(":") ? actual[index]!.length > 0 : actual[index] === part);
}

function expectedAttachAllows(method: string, pathname: string): boolean {
  return [...EXPECTED_ATTACH_ROUTE_KEYS].some((key) => {
    const separator = key.indexOf(" ");
    return key.slice(0, separator) === method
      && matchesExpectedTemplate(pathname, key.slice(separator + 1));
  });
}

describe("AttachRoutePolicy 防漂移契约", () => {
  it("Hono endpoint 与手维护注册目录集合完全相等", () => {
    const actual = new Set(app.routes
      .filter((route) => route.method !== "ALL")
      .map((route) => routeKey(route.method, route.path)));
    const expected = new Set(SERVER_ROUTE_CATALOG.map((route) =>
      routeKey(route.method, route.honoPathTemplate)));
    expect(actual).toEqual(expected);
    expect(expected).toEqual(new Set(EXPECTED_ROUTE_CLASSES.map(([, method, template]) =>
      routeKey(method, template))));
  });

  it("attach 允许表每项都具备完整机器约束且无重复", () => {
    const keys = ATTACH_ROUTE_POLICY.map((entry) => routeKey(entry.method, entry.honoPathTemplate));
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys)).toEqual(EXPECTED_ATTACH_ROUTE_KEYS);
    expect(new Set(ATTACH_DATA_ROUTE_TEMPLATES.map(([method, template]) =>
      routeKey(method, template)))).toEqual(EXPECTED_ATTACH_ROUTE_KEYS);
    for (const entry of ATTACH_ROUTE_POLICY) {
      expect(entry.headerLimit).toBeGreaterThan(0);
      expect(entry.bodyLimit).toBeGreaterThanOrEqual(0);
      const params = [...entry.honoPathTemplate.matchAll(/:([^/]+)/g)].map((match) => match[1]);
      expect(Object.keys(entry.paramConstraints).sort()).toEqual(params.sort());
    }
  });

  it("每个 route × method × principal 按独立预期表判定，禁止前缀和模板外 method", () => {
    const session = createAttachSession({ identity, desktopCapabilities: capabilities }).session;
    session.effectiveCapabilities = { ...capabilities };
    const principals: Record<string, RequestPrincipal> = {
      anonymous: { kind: "anonymous" },
      global: { kind: "global" },
      externalInstance: { kind: "externalInstance", instanceId: identity.instanceId },
      attachSession: { kind: "attachSession", session },
    };
    for (const [routeClass, method, template] of EXPECTED_ROUTE_CLASSES) {
      const pathname = samplePath(template);
      const expected = {
        anonymous: routeClass === "legacy" ? "legacy" : "deny",
        global: routeClass === "legacy" ? "legacy" : "deny",
        externalInstance: routeClass === "legacy" ? "deny" : "allow",
        attachSession: expectedAttachAllows(method, pathname) ? "allow" : "deny",
      } as const;
      for (const [principalName, principal] of Object.entries(principals)) {
        expect(routeAuthorizationDecision(principal, method, pathname),
          `${principalName} ${method} ${template}`).toBe(expected[principalName as keyof typeof expected]);
      }
      for (const candidateMethod of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
        // HTTP 语义:门禁把 HEAD 视同 GET(深链 HEAD 探测实证),预期表按 GET 行取值。
        const lookupMethod = candidateMethod === "HEAD" ? "GET" : candidateMethod;
        const candidateClass = EXPECTED_ROUTE_CLASSES.find(([, expectedMethod, expectedTemplate]) =>
          expectedMethod === lookupMethod && matchesExpectedTemplate(pathname, expectedTemplate))?.[0];
        const expectedByPrincipal = {
          anonymous: candidateClass === "legacy" ? "legacy" : "deny",
          global: candidateClass === "legacy" ? "legacy" : "deny",
          externalInstance: candidateClass === "handshake" || candidateClass === "external"
            ? "allow"
            : "deny",
          attachSession: expectedAttachAllows(lookupMethod, pathname)
            ? "allow"
            : "deny",
        } as const;
        for (const [principalName, principal] of Object.entries(principals)) {
          expect(routeAuthorizationDecision(principal, candidateMethod, pathname),
            `${principalName} ${candidateMethod} ${template}`)
            .toBe(expectedByPrincipal[principalName as keyof typeof expectedByPrincipal]);
        }
      }
      expect(routeAuthorizationDecision({ kind: "attachSession", session }, method, `${pathname}/extra/unregistered`))
        .toBe("deny");
    }
    expect(routeAuthorizationDecision({ kind: "global" }, "GET", "/api/v1/new-unregistered")).toBe("deny");
  });
});

describe("AttachOperationPolicy 防漂移契约", () => {
  it("附录 B 与 COMMAND_KINDS 双向集合相等且恰为 39 项", () => {
    const policyKinds = ATTACH_COMMAND_OPERATION_POLICY.map((entry) => entry.kind);
    expect(policyKinds).toHaveLength(39);
    expect(new Set(policyKinds).size).toBe(policyKinds.length);
    expect(new Set(policyKinds)).toEqual(new Set(COMMAND_KINDS));
  });

  it("round5 两个审阅启动操作允许，所有 disabled mutation 精确拒绝", () => {
    const byKind = new Map(ATTACH_COMMAND_OPERATION_POLICY.map((entry) => [entry.kind, entry]));
    expect(byKind.get("selectReviewTemplate")).toMatchObject({ allowInAttach: true, requiredCapability: "review" });
    expect(byKind.get("upsertReviewSupplement")).toMatchObject({ allowInAttach: true, requiredCapability: "review" });
    expect(byKind.get("setEnabledLexicons")).toMatchObject({ allowInAttach: false, requiredCapability: "lexiconMutation" });
    expect(byKind.get("externalPropose")).toMatchObject({ allowInAttach: false, requiredCapability: null });
  });
});

describe("HEAD 视同 GET(深链探测)", () => {
  it("external doc 路由的 HEAD 判定与 GET 一致", () => {
    const path = "/api/v1/external/sessions/abc/doc";
    const principal = { kind: "externalInstance" } as never;
    expect(routeAuthorizationDecision(principal, "HEAD", path))
      .toBe(routeAuthorizationDecision(principal, "GET", path));
    expect(routeAuthorizationDecision(principal, "HEAD", path)).toBe("allow");
  });
  it("目录外路径的 HEAD 仍拒绝", () => {
    const principal = { kind: "externalInstance" } as never;
    expect(routeAuthorizationDecision(principal, "HEAD", "/api/v1/commands")).toBe("deny");
  });
})
