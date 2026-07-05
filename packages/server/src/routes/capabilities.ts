import { Hono } from "hono";
import type { ClientCapabilities } from "@qingagent/contract-ts";
import {
  browserFolderSourcesEnabled,
  localFolderSourcesEnabled,
} from "@qingagent/core";
import { isSkillMutationAllowed } from "./skills";

export const capabilitiesRoutes = new Hono();

capabilitiesRoutes.get("/capabilities", (c) => {
  const capabilities: ClientCapabilities = {
    folderSources: {
      desktopLocal: { enabled: localFolderSourcesEnabled() },
      browserFsAccess: { enabled: browserFolderSourcesEnabled() },
    },
    skills: {
      mutationEnabled: isSkillMutationAllowed(),
    },
  };
  return c.json(capabilities);
});
