import { Hono } from "hono";
import type { ClientCapabilities } from "@qingagent/contract-ts";
import {
  browserFolderSourcesEnabled,
  localFolderSourcesEnabled,
} from "@qingagent/core";
import { isSkillMutationAllowed } from "./skills";
import { getConnectorRuntimeAccess } from "../lib/connectorRuntimeGate";

export const capabilitiesRoutes = new Hono();

let folderSourceEnvLogged = false;

capabilitiesRoutes.get("/capabilities", (c) => {
  logFolderSourceEnvOnce();
  const capabilities: ClientCapabilities = {
    folderSources: {
      desktopLocal: { enabled: localFolderSourcesEnabled() },
      browserFsAccess: { enabled: browserFolderSourcesEnabled() },
    },
    skills: {
      mutationEnabled: isSkillMutationAllowed(),
    },
    connectors: getConnectorRuntimeAccess().capability,
  };
  return c.json(capabilities);
});

function logFolderSourceEnvOnce(): void {
  if (folderSourceEnvLogged) return;
  folderSourceEnvLogged = true;
  console.info("[capabilities] folderSources env", {
    runtime: process.env.QINGAGENT_RUNTIME ?? null,
    localFolderSources: process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES ?? null,
    browserFolderSources: process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES ?? null,
    desktopLocalEnabled: localFolderSourcesEnabled(),
    platform: process.platform,
    pid: process.pid,
  });
}
