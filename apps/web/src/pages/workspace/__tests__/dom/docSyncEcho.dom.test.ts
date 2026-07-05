// @vitest-environment jsdom

import { Editor, type JSONContent } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { normalizePmDoc, type PmDoc } from "@qingagent/pm-schema";
import { describe, expect, it } from "vitest";
import {
  classifyIncomingDoc,
  pushPendingSelfDocKey,
} from "../../data/docSyncClassify";

// Bug A 接线级回归:用真实 tiptap 编辑器 + 真实 normalizePmDoc 复现"快打字陈旧自我回声"。
// 纯函数测试用的是假字符串键;这里验证真正会出事的接缝——forward 时与 doc-sync 时
// 的键派生(JSON.stringify(normalizePmDoc(...)))必须一致,否则陈旧回声会被误判 external
// 而 setContent 倒回旧内容、光标甩走。该测试同时隐式钉死 normalizePmDoc 的幂等契约。

function makeEditor(): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: createQingagentExtensions(),
    content: docWithText(""),
  });
}

function docWithText(text: string): JSONContent {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "p-1" },
        ...(text ? { content: [{ type: "text", text }] } : {}),
      },
    ],
  };
}

// 复刻生产里两处的键派生:forwardCurrentEditorDoc 与 doc-sync effect 都用它。
function docKey(doc: unknown): string {
  return JSON.stringify(normalizePmDoc(doc as PmDoc));
}

function destroy(editor: Editor) {
  const element = editor.options.element;
  editor.destroy();
  if (element instanceof HTMLElement) element.remove();
}

describe("Bug A 接线级回归 —— 快打字陈旧自我回声不触发 setContent", () => {
  it("打 abc 存盘后继续打 def,abc 的陈旧回声仍判 echo(不倒回内容、不跳光标)", () => {
    const editor = makeEditor();
    try {
      let pendingKeys: string[] = [];

      // 第一次防抖 forward:内容 abc(forwardCurrentEditorDoc 记下该键)。
      editor.commands.setContent(docWithText("abc"));
      const forwardedAbc = normalizePmDoc(editor.getJSON());
      pendingKeys = pushPendingSelfDocKey(pendingKeys, docKey(forwardedAbc));

      // 用户继续快打字 → 编辑器现为 abcdef,第二次 forward。
      editor.commands.setContent(docWithText("abcdef"));
      const forwardedAbcdef = normalizePmDoc(editor.getJSON());
      pendingKeys = pushPendingSelfDocKey(pendingKeys, docKey(forwardedAbcdef));

      // abc 的保存回声回来:incoming = 当初 forward 的 abc 文档(manualDocSaved 存 lastSentPmDoc)。
      // 编辑器当前已是 abcdef —— 旧逻辑(incoming===live)会误判 external → setContent(abc) 倒回、跳光标。
      const verdict = classifyIncomingDoc({
        incomingKey: docKey(forwardedAbc),
        liveKey: docKey(editor.getJSON()),
        pendingSelfKeys: pendingKeys,
      });
      expect(verdict.verdict).toBe("echo");
      expect(verdict.matchedSelfIndex).toBe(0);
    } finally {
      destroy(editor);
    }
  });

  it("真·外部变更(agent 写入全新内容)判 external → 该 setContent", () => {
    const editor = makeEditor();
    try {
      editor.commands.setContent(docWithText("abc"));
      const pendingKeys = pushPendingSelfDocKey(
        [],
        docKey(normalizePmDoc(editor.getJSON())),
      );
      const external = normalizePmDoc(
        docWithText("agent 改写后的全新正文") as unknown as PmDoc,
      );
      const verdict = classifyIncomingDoc({
        incomingKey: docKey(external),
        liveKey: docKey(editor.getJSON()),
        pendingSelfKeys: pendingKeys,
      });
      expect(verdict.verdict).toBe("external");
    } finally {
      destroy(editor);
    }
  });

  it("normalizePmDoc 串级幂等(echo 命中所依赖的隐含契约,含标题/列表/加粗等富结构)", () => {
    const editor = makeEditor();
    try {
      editor.commands.setContent({
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [
          { type: "heading", attrs: { blockId: "h-1", level: 2 }, content: [{ type: "text", text: "标题" }] },
          {
            type: "paragraph",
            attrs: { blockId: "p-2" },
            content: [
              { type: "text", text: "粗体", marks: [{ type: "bold" }] },
              { type: "text", text: " 普通" },
            ],
          },
          {
            type: "bulletList",
            attrs: { blockId: "ul-1" },
            content: [
              {
                type: "listItem",
                attrs: { blockId: "li-1" },
                content: [{ type: "paragraph", attrs: { blockId: "p-3" }, content: [{ type: "text", text: "项一" }] }],
              },
            ],
          },
        ],
      });
      const once = normalizePmDoc(editor.getJSON());
      // forward 时 push 的键 = JSON.stringify(once);回声时算 = JSON.stringify(normalizePmDoc(once))。
      // 二者必须逐字节相等,否则 echo 永远命不中、Bug A 复发。
      expect(JSON.stringify(normalizePmDoc(once))).toBe(JSON.stringify(once));
    } finally {
      destroy(editor);
    }
  });
});
