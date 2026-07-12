import assert from "node:assert/strict";
import test from "node:test";
import { localFolderSourcesEnabled } from "@qingagent/core";
import { configureDesktopRuntimeEnv } from "./desktopRuntimeEnv";

test("configureDesktopRuntimeEnv 打开桌面本地文件夹能力和技能 mutation gate", (t) => {
  const savedRuntime = process.env.QINGAGENT_RUNTIME;
  const savedLocal = process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;
  const savedMutation = process.env.QINGAGENT_ALLOW_SKILL_MUTATION;
  const savedConnectors = process.env.QINGAGENT_CONNECTORS_ENABLED;
  t.after(() => {
    if (savedRuntime === undefined) delete process.env.QINGAGENT_RUNTIME;
    else process.env.QINGAGENT_RUNTIME = savedRuntime;
    if (savedLocal === undefined) delete process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;
    else process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = savedLocal;
    if (savedMutation === undefined) delete process.env.QINGAGENT_ALLOW_SKILL_MUTATION;
    else process.env.QINGAGENT_ALLOW_SKILL_MUTATION = savedMutation;
    if (savedConnectors === undefined) delete process.env.QINGAGENT_CONNECTORS_ENABLED;
    else process.env.QINGAGENT_CONNECTORS_ENABLED = savedConnectors;
  });

  delete process.env.QINGAGENT_RUNTIME;
  delete process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;
  delete process.env.QINGAGENT_ALLOW_SKILL_MUTATION;
  delete process.env.QINGAGENT_CONNECTORS_ENABLED;

  configureDesktopRuntimeEnv(process.env);

  assert.equal(process.env.QINGAGENT_RUNTIME, "desktop");
  assert.equal(process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES, "1");
  assert.equal(process.env.QINGAGENT_ALLOW_SKILL_MUTATION, "1");
  assert.equal(process.env.QINGAGENT_CONNECTORS_ENABLED, "1");
  assert.equal(localFolderSourcesEnabled(), true);
});

test("configureDesktopRuntimeEnv 保留显式 connector kill switch", () => {
  const env = { QINGAGENT_CONNECTORS_ENABLED: "0" };
  configureDesktopRuntimeEnv(env);
  assert.equal(env.QINGAGENT_CONNECTORS_ENABLED, "0");
});
