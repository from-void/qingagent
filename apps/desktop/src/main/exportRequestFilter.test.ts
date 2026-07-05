import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedExportRequest } from "./exportRequestFilter.js";
import { ToolCallStreamScanner } from "./toolCallStreamScanner.js";

// 导出窗口请求放行判定:对抗性输入(各种协议/host),只放行自包含资源 + Google Fonts,
// 其余一律拦截(防 SSRF、避免外部资源拖慢/卡住 printToPDF)。
test("file:/data:/about: 放行(自包含 HTML 与内联资源)", () => {
  assert.equal(isAllowedExportRequest("file:///tmp/qingagent-export-1.html"), true);
  assert.equal(isAllowedExportRequest("data:image/png;base64,AAAA"), true);
  assert.equal(isAllowedExportRequest("about:blank"), true);
});

test("Google Fonts 域放行(联网取中文字体)", () => {
  assert.equal(
    isAllowedExportRequest("https://fonts.googleapis.com/css2?family=Noto+Serif+SC"),
    true,
  );
  assert.equal(isAllowedExportRequest("https://fonts.gstatic.com/s/notoserifsc/x.woff2"), true);
});

test("其余外部请求一律拦截", () => {
  // 任意第三方/内网/云元数据端点都要拦,防 SSRF。
  assert.equal(isAllowedExportRequest("https://evil.example.com/steal"), false);
  assert.equal(isAllowedExportRequest("http://169.254.169.254/latest/meta-data/"), false);
  assert.equal(isAllowedExportRequest("https://fonts.googleapis.com.evil.com/x"), false);
  assert.equal(isAllowedExportRequest("https://sub.fonts.gstatic.com/x"), false);
});

test("非法/异常 URL 按拦截处理,不抛", () => {
  assert.equal(isAllowedExportRequest("not a url"), false);
  assert.equal(isAllowedExportRequest(""), false);
  assert.equal(isAllowedExportRequest("javascript:alert(1)"), false);
  assert.equal(isAllowedExportRequest("ftp://fonts.gstatic.com/x"), false);
});

test("tool call 埋点扫描:跨 chunk carry 重扫不重复上报", async () => {
  const tracked: string[] = [];
  const scanner = new ToolCallStreamScanner((name) => tracked.push(name), {
    maxSeenIds: 10,
    carryChars: 256,
  });
  const frame = toolCallFrame("call-a", "writeDraft");

  await scanner.scan(streamFromChunks([frame.slice(0, 70), frame.slice(70), frame]));

  assert.deepEqual(tracked, ["writeDraft"]);
});

test("tool call 埋点扫描:seen 上限只淘汰最旧项,不整批清空", async () => {
  const tracked: string[] = [];
  const scanner = new ToolCallStreamScanner((name) => tracked.push(name), {
    maxSeenIds: 3,
    carryChars: 0,
  });

  await scanner.scan(
    streamFromChunks([
      toolCallFrame("call-a", "toolA") +
        toolCallFrame("call-b", "toolB") +
        toolCallFrame("call-c", "toolC") +
        toolCallFrame("call-d", "toolD") +
        toolCallFrame("call-e", "toolE"),
    ]),
  );
  await scanner.scan(streamFromChunks([toolCallFrame("call-d", "toolD")]));

  assert.deepEqual(tracked, ["toolA", "toolB", "toolC", "toolD", "toolE"]);
});

function toolCallFrame(callId: string, name: string): string {
  return `data: {"kind":"toolCallUpdated","data":{"messageId":"m","toolCallId":"${callId}","spec":{"id":"s","name":"${name}","args":{}}}}\n\n`;
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}
