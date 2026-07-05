import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const TELEMETRY_BUILD_INFO_FILENAME = "telemetry-build-info.json";

function readEnvString(env, key) {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}

export function collectTelemetryBuildInfo(env = process.env) {
  const info = {
    telemetryEndpoint: readEnvString(env, "QINGAGENT_TELEMETRY_ENDPOINT"),
  };
  const updatePolicyUrl = readEnvString(env, "QINGAGENT_UPDATE_POLICY_URL");
  if (updatePolicyUrl) info.updatePolicyUrl = updatePolicyUrl;
  return info;
}

export function writeTelemetryBuildInfo({ outdir = "dist/main", env = process.env } = {}) {
  const info = collectTelemetryBuildInfo(env);
  mkdirSync(outdir, { recursive: true });
  const file = path.join(outdir, TELEMETRY_BUILD_INFO_FILENAME);
  writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`, "utf8");
  return { file, info };
}
