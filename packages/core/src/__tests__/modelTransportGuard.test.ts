import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(process.cwd(), "../..");
const scanRoots = ["packages/core/src", "packages/server/src"];
const allowlist = new Set([
  // BranchCall 的 raw 回放器必须与 provider 自定义 fetch 同住这一文件；禁止扩散第二个推理出口。
  "packages/core/src/llm/modelConfig.ts",
  "packages/core/src/search/deepseekWebSearch.ts",
]);

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
    expect([...allowlist].filter((path) => path.includes("modelConfig"))).toEqual([
      "packages/core/src/llm/modelConfig.ts",
    ]);
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
