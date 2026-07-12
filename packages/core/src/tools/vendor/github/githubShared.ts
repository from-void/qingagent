import { createHash } from "node:crypto";
import { getConnectorCredentialBundle } from "../../../credentials/credentialsRepo.js";
import { GithubClient } from "../../../connectors/github/githubClient.js";
import type { GithubCredentialPayload } from "../../../connectors/githubConnector.js";

export async function githubClient(allowAnonymous = true): Promise<{ client: GithubClient; connected: boolean }> {
  const bundle = await getConnectorCredentialBundle<GithubCredentialPayload>("github");
  if (!bundle && !allowAnonymous) throw Object.assign(new Error("请先连接 GitHub"), { code: "GITHUB_NOT_CONNECTED", status: 401 });
  return { client: new GithubClient({ token: bundle?.payload.token, baseUrl: process.env.QINGAGENT_GITHUB_API_BASE_URL }), connected: Boolean(bundle) };
}

export function githubMaterialId(owner: string, repo: string, path: string, ref: string | undefined): string {
  return `github-${createHash("sha256").update(`${owner}\0${repo}\0${path}\0${ref ?? ""}`).digest("hex").slice(0, 24)}`;
}
