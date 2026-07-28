import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  githubClient: vi.fn(),
  listRepos: vi.fn(),
}));

vi.mock("../githubShared.js", () => ({
  githubClient: mocks.githubClient,
}));

import { githubListReposTool } from "../githubListRepos.js";

describe("github_list_repos", () => {
  beforeEach(() => {
    mocks.githubClient.mockReset();
    mocks.listRepos.mockReset();
    mocks.githubClient.mockResolvedValue({
      connected: true,
      client: { listRepos: mocks.listRepos },
    });
  });

  it("只读取指定页并明确返回后续页与截断状态", async () => {
    mocks.listRepos.mockResolvedValue({
      data: [{
        owner: { login: "octo" },
        name: "repo-101",
        full_name: "octo/repo-101",
        private: false,
        default_branch: "main",
        html_url: "https://github.com/octo/repo-101",
      }],
      nextPage: 3,
      rateLimit: { limit: 5_000, remaining: 4_999, resetAt: null, resource: "core" },
    });
    if (!githubListReposTool.execute) throw new Error("github_list_repos execute missing");

    const result = await githubListReposTool.execute(
      { owner: "octo", page: 2 },
      { toolCallId: "github-list-repos-test", messages: [] } as never,
    );

    expect(mocks.listRepos).toHaveBeenCalledWith("octo", 2, undefined);
    expect(result).toMatchObject({
      page: 2,
      nextPage: 3,
      truncated: true,
      count: 1,
    });
  });
});
