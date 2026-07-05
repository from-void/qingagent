import { describe, expect, it } from "vitest";
import { redactDiagnosticText, redactValueDeep } from "../diagnostics/redact";

const dirtyFixtures = [
  {
    name: "prompt 正文里夹带 key",
    raw: "请处理这个 prompt，key=sk-live-secret-12345，路径 /home/alice/projects/qingagent",
  },
  {
    name: "error stack 里夹带 Bearer 和本机路径",
    raw: "Error: failed\n    at run (/Users/alice/work/app.ts:12)\nAuthorization: Bearer token-secret-987",
  },
  {
    name: "HTTP header dump",
    raw: "POST /v1\nAuthorization: Bearer sk-header-secret\nx-api-key: ghp_headersecret\ncookie: sid=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature987",
  },
  {
    name: "framelog 正文",
    raw: "chat text: file:///home/alice/private/doc.md and \\\\NAS\\share\\secret with C:\\Users\\alice\\key.txt",
  },
  {
    name: "JSON 字符串内含转义引号",
    raw: String.raw`{\"authorization\":\"Bearer sk-json-secret\",\"message\":\"/home/alice/a \\\"quoted\\\" value\"}`,
  },
];

describe("diagnostics redaction", () => {
  it("redactDiagnosticText 覆盖真实脏样本", () => {
    const output = dirtyFixtures.map((fixture) => redactDiagnosticText(fixture.raw)).join("\n");

    expect(output).not.toContain("sk-live-secret");
    expect(output).not.toContain("token-secret-987");
    expect(output).not.toContain("sk-header-secret");
    expect(output).not.toContain("ghp_headersecret");
    expect(output).not.toContain("sk-json-secret");
    expect(output).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(output).not.toContain("/home/alice");
    expect(output).not.toContain("/Users/alice");
    expect(output).not.toMatch(/Authorization:\s*Bearer/i);
    expect(output).toContain("~");
  });

  it("redactValueDeep 递归处理 span meta/error/settings 形态", () => {
    const redacted = redactValueDeep({
      meta: {
        prompt: "use sk-nested-secret at /home/alice/project",
        headers: { authorization: "Bearer nested-token" },
      },
      error: {
        stack: "Error at /Users/alice/app.ts with eyJabcdef.eyJghijkl.eyJmnopqr",
      },
      array: ["x-api-key: ghp_nestedsecret", { cookie: "sid=secret" }],
    }) as Record<string, unknown>;

    const text = JSON.stringify(redacted);
    expect(text).not.toContain("sk-nested-secret");
    expect(text).not.toContain("nested-token");
    expect(text).not.toContain("ghp_nestedsecret");
    expect(text).not.toContain("/home/alice");
    expect(text).not.toContain("/Users/alice");
    expect(text).toContain("~");
  });
});
