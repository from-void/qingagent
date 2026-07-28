import { describe, expect, it } from "vitest";
import {
  ConnectorMutationForbiddenError,
  getConnectorRuntimeAccess,
} from "../lib/connectorRuntimeGate.js";

describe("connector runtime gate", () => {
  it.each([
    {
      name: "默认关闭",
      env: {},
      enabled: false,
      reasonCode: "SINGLE_USER_OPT_IN_REQUIRED",
    },
    {
      name: "desktop 未显式启用",
      env: { QINGAGENT_RUNTIME: "desktop" },
      enabled: false,
      reasonCode: "CONNECTORS_DISABLED",
    },
    {
      name: "desktop embedded 显式启用",
      env: { QINGAGENT_RUNTIME: "desktop", QINGAGENT_CONNECTORS_ENABLED: "1" },
      enabled: true,
      reasonCode: null,
    },
    {
      name: "headless 未 single-user opt-in",
      env: { QINGAGENT_AUTH_TOKEN: "secret" },
      enabled: false,
      reasonCode: "SINGLE_USER_OPT_IN_REQUIRED",
    },
    {
      name: "headless 回环 single-user opt-in",
      env: { QINGAGENT_SINGLE_USER: "1" },
      enabled: true,
      reasonCode: null,
    },
    {
      name: "headless 规范化 IPv6 回环 single-user opt-in",
      env: { QINGAGENT_SINGLE_USER: "1", QINGAGENT_HOST: " [::1] " },
      enabled: true,
      reasonCode: null,
    },
    {
      name: "desktop 规范化 localhost 后允许显式启用",
      env: {
        QINGAGENT_RUNTIME: "desktop",
        QINGAGENT_CONNECTORS_ENABLED: "1",
        QINGAGENT_HOST: " LOCALHOST ",
      },
      enabled: true,
      reasonCode: null,
    },
    {
      name: "headless 对外监听但无 AUTH_TOKEN",
      env: { QINGAGENT_SINGLE_USER: "1", QINGAGENT_HOST: "0.0.0.0" },
      enabled: false,
      reasonCode: "AUTH_TOKEN_REQUIRED",
    },
    {
      name: "headless 对外监听且有 AUTH_TOKEN",
      env: {
        QINGAGENT_SINGLE_USER: "1",
        QINGAGENT_HOST: "0.0.0.0",
        QINGAGENT_AUTH_TOKEN: "secret",
      },
      enabled: true,
      reasonCode: null,
    },
    {
      name: "public 即使 opt-in/token 齐全也无条件关闭",
      env: {
        QINGAGENT_PUBLIC_DEPLOYMENT: "1",
        QINGAGENT_SINGLE_USER: "1",
        QINGAGENT_AUTH_TOKEN: "secret",
      },
      enabled: false,
      reasonCode: "PUBLIC_DEPLOYMENT",
    },
  ])("$name", ({ env, enabled, reasonCode }) => {
    const access = getConnectorRuntimeAccess(env);
    expect(access.capability).toEqual({ mutationEnabled: enabled, reasonCode });
    if (enabled) {
      expect(() => access.assertMutationAllowed()).not.toThrow();
    } else {
      expect(() => access.assertMutationAllowed()).toThrow(ConnectorMutationForbiddenError);
      try {
        access.assertMutationAllowed();
      } catch (error) {
        expect(error).toMatchObject({
          status: 403,
          code: "CONNECTOR_MUTATION_FORBIDDEN",
          reasonCode,
        });
      }
    }
  });
});
