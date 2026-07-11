import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(process.cwd(), "../..");
const scanRoots = ["packages/core/src", "packages/server/src"];
const branchReplayAllowlist = new Set([
  "packages/core/src/llm/modelConfig.ts",
]);
const specializedTransportAllowlist = new Set([
  "packages/core/src/search/deepseekWebSearch.ts",
]);
const allowlist = new Set([...branchReplayAllowlist, ...specializedTransportAllowlist]);

export function findRawModelTransport(source: string): string[] {
  if (!/\bfetch\s*\(/.test(source)) return [];
  const findings: string[] = [];
  if (/api\.(?:deepseek|openai|anthropic)\.[a-z.]+/i.test(source) &&
      /(?:chat\/completions|\/messages\b|\/completions\b)/i.test(source)) {
    findings.push("模型域名 + 裸推理 endpoint + fetch");
  }
  if (/(?:`|'|")\/?(?:chat\/completions|messages|completions)(?:`|'|")/i.test(source)) {
    findings.push("fetch 文件内拼接裸推理 endpoint");
  }
  if (
    /\bfetch\s*\([\s\S]*?\bbody\s*:\s*JSON\.stringify\s*\(/.test(source) &&
    /\bauthorization\b|\bx-api-key\b/i.test(source) &&
    /\bmodel\b/.test(source) &&
    /\bmessages\b/.test(source)
  ) {
    findings.push("动态 endpoint + 授权头 + model/messages JSON 裸传输");
  }
  return findings;
}

function sourceFiles(root: string): string[] {
  const absolute = resolve(repoRoot, root);
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && path.endsWith(".ts") && !path.includes("__tests__") && !path.endsWith(".test.ts")) {
        out.push(path);
      }
    }
  };
  visit(absolute);
  return out;
}

describe("模型传输静态守护", () => {
  it("BranchCall 裸回放只有 modelConfig 一个豁免点", () => {
    expect([...branchReplayAllowlist]).toEqual([
      "packages/core/src/llm/modelConfig.ts",
    ]);
    expect([...specializedTransportAllowlist]).toEqual([
      "packages/core/src/search/deepseekWebSearch.ts",
    ]);
    expect([...allowlist].sort()).toEqual([
      "packages/core/src/llm/modelConfig.ts",
      "packages/core/src/search/deepseekWebSearch.ts",
    ]);
  });
  it("modelConfig 内 raw endpoint 仅由 branchCall 使用且每条网络终态都接入记账", () => {
    const source = readFileSync(resolve(repoRoot, "packages/core/src/llm/modelConfig.ts"), "utf8");
    const branchStart = source.indexOf("export async function branchCall");
    const branchEnd = source.indexOf("\nfunction envModelProtocol", branchStart);
    const rawFetch = "globalThis.fetch(input.sessionSnapshot.endpoint";
    const rawFetchIndex = source.indexOf(rawFetch);
    expect(branchStart).toBeGreaterThanOrEqual(0);
    expect(branchEnd).toBeGreaterThan(branchStart);
    expect(rawFetchIndex).toBeGreaterThan(branchStart);
    expect(rawFetchIndex).toBeLessThan(branchEnd);
    expect(source.match(/globalThis\.fetch\(input\.sessionSnapshot\.endpoint/g)).toHaveLength(1);
    const branchSource = source.slice(branchStart, branchEnd);
    expect(branchSource.match(/recordBranchUsage\(input/g)).toHaveLength(4);
    expect(branchSource).toContain("providerErrorSummary(response)");
    expect(branchSource).toContain("recordBranchUsage(input, null, attempt, error)");
    expect(branchSource).toContain("provider_request_aborted");
    expect(branchSource).toContain("provider_request_error");
  });
  it("构造的裸 DeepSeek fetch 与 endpoint 拼接都会被拦", () => {
    expect(findRawModelTransport(`
      const endpoint = "https://api.deepseek.com/v1/chat/completions";
      await fetch(endpoint);
    `)).not.toEqual([]);
    expect(findRawModelTransport(`
      const endpoint = baseUrl + "/messages";
      await fetch(endpoint);
    `)).not.toEqual([]);
    expect(findRawModelTransport(`
      const body = { model, messages, tools };
      await fetch(snapshot.endpoint, {
        headers: { authorization: "Bearer secret" },
        body: JSON.stringify(body),
      });
    `)).toContain("动态 endpoint + 授权头 + model/messages JSON 裸传输");
  });

  it("产品源码除明确白名单外不出现裸模型传输", () => {
    const violations: string[] = [];
    for (const root of scanRoots) {
      for (const path of sourceFiles(root)) {
        const repoPath = relative(repoRoot, path).replace(/\\/g, "/");
        if (allowlist.has(repoPath)) continue;
        const findings = findRawModelTransport(readFileSync(path, "utf8"));
        if (findings.length > 0) violations.push(`${repoPath}: ${findings.join("；")}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
