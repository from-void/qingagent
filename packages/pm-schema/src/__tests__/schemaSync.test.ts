// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { PmDoc as ContractPmDoc, PmFileAttachment as ContractPmFileAttachment } from "@qingagent/contract-ts";
import { pmToClipboardHtml } from "../clipboard/pmToClipboardHtml";
import { getQingagentTiptapNodeNames } from "../tiptap/createQingagentExtensions";
import {
  PM_SCHEMA_MARK_NAMES,
  PM_SCHEMA_NODE_NAMES,
  pmSchemaSpec,
} from "../spec";
import {
  PM_VALIDATOR_MARK_NAMES,
  PM_VALIDATOR_NODE_NAMES,
  safeParsePmDoc,
} from "../validators";

describe("schemaSync", () => {
  it("keeps spec, validator, and TipTap factory node names aligned", () => {
    expect(PM_VALIDATOR_NODE_NAMES).toEqual(PM_SCHEMA_NODE_NAMES);
    expect(getQingagentTiptapNodeNames()).toEqual(PM_SCHEMA_NODE_NAMES);
    expect(Object.keys(pmSchemaSpec.nodes)).toEqual([...PM_SCHEMA_NODE_NAMES]);
  });

  it("keeps spec and validator mark names aligned", () => {
    expect(PM_VALIDATOR_MARK_NAMES).toEqual(PM_SCHEMA_MARK_NAMES);
    expect(Object.keys(pmSchemaSpec.marks)).toEqual([...PM_SCHEMA_MARK_NAMES]);
  });

  it("uses fileAttachment for PM attachments and leaves contract ResourceRef terminology alone", () => {
    const attachment: ContractPmFileAttachment = {
      fileId: "file_1",
      filename: "brief.pdf",
      mimeType: "application/pdf",
      size: 128,
    };
    const doc: ContractPmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "fileAttachment",
          attrs: {
            blockId: "block-file",
            ...attachment,
          },
        },
      ],
    };

    expect(safeParsePmDoc(doc).success).toBe(true);
    expect(PM_SCHEMA_NODE_NAMES).toContain("fileAttachment");
    expect(PM_SCHEMA_NODE_NAMES).not.toContain("resourceRef");
  });

  it("inlineMath 与 hardBreak 的 marks 经校验、归一化和 runtime schema 往返后保留", async () => {
    const doc: ContractPmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "paragraph",
        attrs: { blockId: "marked-atoms" },
        content: [
          {
            type: "inlineMath",
            attrs: { latex: "E=mc^2" },
            marks: [
              { type: "bold" },
              { type: "link", attrs: { href: "https://example.com/math", title: "公式" } },
            ],
          },
          {
            type: "hardBreak",
            marks: [{ type: "textColor", attrs: { color: "red" } }],
          },
        ],
      }],
    };

    const parsed = safeParsePmDoc(doc);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    expect(parsed.data).toEqual(doc);

    const { getSchema } = await import("@tiptap/core");
    const { Node: PMNode } = await import("@tiptap/pm/model");
    const { createQingagentExtensions } = await import("../tiptap/createQingagentExtensions");
    const reloaded = PMNode.fromJSON(getSchema(createQingagentExtensions()), parsed.data).toJSON();
    expect(reloaded.content?.[0]?.content?.[0]).toMatchObject({
      type: "inlineMath",
      attrs: { latex: "E=mc^2" },
      marks: expect.arrayContaining([
        { type: "bold" },
        { type: "link", attrs: expect.objectContaining({ href: "https://example.com/math", title: "公式" }) },
      ]),
    });
    expect(reloaded.content?.[0]?.content?.[1]).toMatchObject({
      type: "hardBreak",
      marks: [{ type: "textColor", attrs: { color: "red" } }],
    });
    expect(safeParsePmDoc(reloaded).success).toBe(true);
  });

  it("tableCell/tableHeader schema 均拒绝直接嵌套 table", async () => {
    const nestedTableDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "table",
        attrs: { blockId: "outer" },
        content: [{
          type: "tableRow",
          content: [{
            type: "tableCell",
            content: [{
              type: "table",
              attrs: { blockId: "inner" },
              content: [{
                type: "tableRow",
                content: [{ type: "tableCell", content: [{ type: "paragraph", attrs: { blockId: "inner-p" } }] }],
              }],
            }],
          }],
        }],
      }],
    };
    expect(safeParsePmDoc(nestedTableDoc).success).toBe(false);

    const { getSchema } = await import("@tiptap/core");
    const { Node: PMNode } = await import("@tiptap/pm/model");
    const { createQingagentExtensions } = await import("../tiptap/createQingagentExtensions");
    const schema = getSchema(createQingagentExtensions());
    expect(schema.nodes.tableCell!.spec.content).not.toBe("block+");
    expect(() => PMNode.fromJSON(schema, nestedTableDoc).check()).toThrow();
  });

  it("cell 内经列表递归嵌入 table 仍被 validator 与编辑事务拒绝", async () => {
    const inner = {
      type: "table",
      attrs: { blockId: "inner" },
      content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", attrs: { blockId: "inner-p" } }] }] }],
    };
    const nestedBlock = {
      type: "bulletList",
      attrs: { blockId: "list" },
      content: [{ type: "listItem", attrs: { blockId: "item" }, content: [{ type: "paragraph", attrs: { blockId: "item-p" } }, inner] }],
    };
    const nestedDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "table",
        attrs: { blockId: "outer" },
        content: [{ type: "tableRow", content: [{ type: "tableCell", content: [nestedBlock] }] }],
      }],
    };
    expect(safeParsePmDoc(nestedDoc).success).toBe(false);

    const { Editor } = await import("@tiptap/core");
    const { createQingagentExtensions } = await import("../tiptap/createQingagentExtensions");
    const editor = new Editor({
      extensions: createQingagentExtensions(),
      content: { type: "doc", attrs: { schemaVersion: 1 }, content: [{ type: "paragraph", attrs: { blockId: "before" }, content: [{ type: "text", text: "保留" }] }] },
    });
    try {
      editor.commands.setContent(nestedDoc);
      expect(editor.getText()).toBe("保留");
      expect(JSON.stringify(editor.getJSON())).not.toContain('"blockId":"inner"');
    } finally {
      editor.destroy();
    }
  });
});

describe("p02 回归:TipTap runtime schema 必须真实覆盖全部 PM 节点", () => {
  it("实例化扩展后 schema.nodes 覆盖 PM_SCHEMA_NODE_NAMES(不再只比声明常量)", async () => {
    // 此前只比对 getQingagentTiptapNodeNames() 返回的常量列表——penNote 声明了
    // 却没注册真实 Node,提交后编辑器装载抛 Unknown node type 渲染空白。
    const { getSchema } = await import("@tiptap/core");
    const { createQingagentExtensions } = await import("../tiptap/createQingagentExtensions");
    const schema = getSchema(createQingagentExtensions());
    const runtimeNodeNames = new Set(Object.keys(schema.nodes));
    const missing = PM_SCHEMA_NODE_NAMES.filter(
      (name) => name !== "doc" && !runtimeNodeNames.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("含 taskList/callout/blockMath/inlineMath 的 PM 文档可被 runtime schema 装载", async () => {
    const { getSchema } = await import("@tiptap/core");
    const { Node: PMNode } = await import("@tiptap/pm/model");
    const { createQingagentExtensions } = await import("../tiptap/createQingagentExtensions");
    const schema = getSchema(createQingagentExtensions());
    const doc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "taskList",
          attrs: { blockId: "block-tasks" },
          content: [
            {
              type: "taskItem",
              attrs: { blockId: "block-tasks-item-1", checked: true },
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "block-tasks-item-1-p" },
                  content: [{ type: "text", text: "已完成" }],
                },
              ],
            },
          ],
        },
        {
          type: "callout",
          attrs: { blockId: "block-callout", emoji: "💡", tone: "info" },
          content: [
            {
              type: "paragraph",
              attrs: { blockId: "block-callout-p" },
              content: [
                { type: "text", text: "提示与行内公式 " },
                { type: "inlineMath", attrs: { latex: "a^2+b^2=c^2" } },
              ],
            },
          ],
        },
        { type: "blockMath", attrs: { blockId: "block-math", latex: "E = mc^2" } },
      ],
    };
    const node = PMNode.fromJSON(schema, doc);
    expect(node.childCount).toBe(3);
    expect(node.child(0).type.name).toBe("taskList");
    expect(node.child(1).type.name).toBe("callout");
    expect(node.child(2).type.name).toBe("blockMath");
  });

  it("taskItem 允许 paragraph 后挂普通块,与 PM spec 的 paragraph block* 对齐", async () => {
    const { getSchema } = await import("@tiptap/core");
    const { Node: PMNode } = await import("@tiptap/pm/model");
    const { createQingagentExtensions } = await import("../tiptap/createQingagentExtensions");
    const schema = getSchema(createQingagentExtensions());
    const doc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "taskList",
        attrs: { blockId: "tasks" },
        content: [{
          type: "taskItem",
          attrs: { blockId: "task-1", checked: false },
          content: [
            {
              type: "paragraph",
              attrs: { blockId: "task-1-p" },
              content: [{ type: "text", text: "父任务" }],
            },
            {
              type: "bulletList",
              attrs: { blockId: "task-1-list" },
              content: [{
                type: "listItem",
                attrs: { blockId: "task-1-list-item" },
                content: [{
                  type: "paragraph",
                  attrs: { blockId: "task-1-list-item-p" },
                  content: [{ type: "text", text: "缩进子项" }],
                }],
              }],
            },
          ],
        }],
      }],
    };

    expect(safeParsePmDoc(doc).success).toBe(true);
    const node = PMNode.fromJSON(schema, doc);
    expect(node.child(0).child(0).child(1).type.name).toBe("bulletList");
  });

  it("listItem 首子必须是 paragraph，canonical validator 与真实 TipTap schema 同步拒绝非法 heading", async () => {
    const { getSchema } = await import("@tiptap/core");
    const { Node: PMNode } = await import("@tiptap/pm/model");
    const { createQingagentExtensions } = await import("../tiptap/createQingagentExtensions");
    const schema = getSchema(createQingagentExtensions());
    const invalid = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "bulletList",
        attrs: { blockId: "list-invalid" },
        content: [{
          type: "listItem",
          attrs: { blockId: "item-invalid" },
          content: [{
            type: "heading",
            attrs: { blockId: "heading-invalid", level: 2 },
            content: [{ type: "text", text: "不能作为列表项首子" }],
          }],
        }],
      }],
    };
    const valid = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "bulletList",
        attrs: { blockId: "list-valid" },
        content: [{
          type: "listItem",
          attrs: { blockId: "item-valid" },
          content: [
            {
              type: "paragraph",
              attrs: { blockId: "item-valid-p" },
              content: [{ type: "text", text: "合法首段" }],
            },
            {
              type: "heading",
              attrs: { blockId: "item-valid-h", level: 3 },
              content: [{ type: "text", text: "后续块允许标题" }],
            },
          ],
        }],
      }],
    };

    expect(pmSchemaSpec.nodes.listItem.content).toBe("paragraph block*");
    expect(schema.nodes.listItem!.spec.content).toBe("paragraph block*");
    expect(safeParsePmDoc(invalid).success).toBe(false);
    expect(() => PMNode.fromJSON(schema, invalid).check()).toThrow();
    expect(safeParsePmDoc(valid).success).toBe(true);
    expect(() => PMNode.fromJSON(schema, valid).check()).not.toThrow();
  });

  it("R2-01 taskItem 下沉后生成嵌套 taskList，且 PM validator 接受", async () => {
    const { Editor } = await import("@tiptap/core");
    const { createQingagentExtensions } = await import("../tiptap/createQingagentExtensions");
    const editor = new Editor({
      extensions: createQingagentExtensions(),
      content: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [{
          type: "taskList",
          attrs: { blockId: "tasks" },
          content: [
            {
              type: "taskItem",
              attrs: { blockId: "task-1", checked: false },
              content: [{
                type: "paragraph",
                attrs: { blockId: "task-1-p" },
                content: [{ type: "text", text: "父任务" }],
              }],
            },
            {
              type: "taskItem",
              attrs: { blockId: "task-2", checked: false },
              content: [{
                type: "paragraph",
                attrs: { blockId: "task-2-p" },
                content: [{ type: "text", text: "子任务" }],
              }],
            },
          ],
        }],
      },
    });

    try {
      let childTextPos = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "子任务") {
          childTextPos = pos + 1;
          return false;
        }
        return true;
      });
      expect(childTextPos).toBeGreaterThan(0);
      editor.commands.setTextSelection(childTextPos);
      expect(editor.commands.sinkListItem("taskItem")).toBe(true);

      const json = editor.getJSON();
      const topTaskList = json.content?.[0] as { content?: Array<{ content?: unknown[] }> };
      const parentTask = topTaskList.content?.[0] as { content?: Array<{ type?: string; content?: unknown[] }> };
      const nestedTaskList = parentTask.content?.find((node) => node.type === "taskList");

      expect(topTaskList.content).toHaveLength(1);
      expect(nestedTaskList).toBeTruthy();
      expect(safeParsePmDoc(json).success).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  it("R2-24 兼容 inlineMath/blockMath 的 data-type 驼峰别名", async () => {
    const { Editor } = await import("@tiptap/core");
    const { createQingagentExtensions } = await import("../tiptap/createQingagentExtensions");
    const editor = new Editor({
      extensions: createQingagentExtensions(),
      content:
        '<p data-block-id="p-math">公式 <span data-type="inlineMath" data-latex="E=mc^2"></span></p>' +
        '<div data-type="blockMath" data-block-id="block-math-alias" data-latex="x=1"></div>',
    });

    try {
      expect(editor.getJSON()).toMatchObject({
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "公式 " },
              { type: "inlineMath", attrs: { latex: "E=mc^2" } },
            ],
          },
          { type: "blockMath", attrs: { blockId: "block-math-alias", latex: "x=1" } },
        ],
      });
    } finally {
      editor.destroy();
    }
	  });

  it("image align 默认居中,并可从 HTML 往返", async () => {
    const { Editor } = await import("@tiptap/core");
    const { createQingagentExtensions } = await import("../tiptap/createQingagentExtensions");
    const src = "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png";
    const editor = new Editor({
      extensions: createQingagentExtensions(),
      content: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [{
          type: "image",
          attrs: { blockId: "img-default", src, alt: "默认图", caption: null, width: null, height: null },
        }],
      },
    });

    try {
      expect(editor.getJSON().content?.[0]?.attrs).toMatchObject({ align: "center" });

      editor.commands.setContent(
        `<img data-block-id="img-right" src="${src}" alt="右图" data-align="right" width="360" style="width:360px;margin-left:auto;display:block" data-caption="图 1" />`,
      );
      const attrs = editor.getJSON().content?.[0]?.attrs;
      expect(attrs).toMatchObject({
        blockId: "img-right",
        align: "right",
        width: 360,
        caption: "图 1",
      });
      const html = editor.getHTML();
      expect(html).toContain('data-align="right"');
      expect(html).toMatch(/width:\s*360px/);
      expect(safeParsePmDoc(editor.getJSON()).success).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  it("orderedList listStyle 可从 HTML/CSS 往返", async () => {
    const { Editor } = await import("@tiptap/core");
    const { createQingagentExtensions } = await import("../tiptap/createQingagentExtensions");
    const editor = new Editor({
      extensions: createQingagentExtensions(),
      content:
        '<ol data-block-id="ol-alpha" style="list-style-type: lower-alpha"><li data-block-id="li-a"><p data-block-id="li-a-p">甲</p></li></ol>' +
        '<ol data-block-id="ol-roman" type="I"><li data-block-id="li-r"><p data-block-id="li-r-p">乙</p></li></ol>',
    });

    try {
      const content = editor.getJSON().content ?? [];
      expect(content[0]?.attrs).toMatchObject({ blockId: "ol-alpha", listStyle: "lower-alpha" });
      expect(content[1]?.attrs).toMatchObject({ blockId: "ol-roman", listStyle: "upper-roman" });
      const html = editor.getHTML();
      expect(html).toContain("list-style-type: lower-alpha");
      expect(html).toContain("list-style-type: upper-roman");
      expect(safeParsePmDoc(editor.getJSON()).success).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  it("剪贴板 HTML 往返保留 orderedList.start", async () => {
    const { Editor } = await import("@tiptap/core");
    const { createQingagentExtensions } = await import("../tiptap/createQingagentExtensions");
    const html = pmToClipboardHtml({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "orderedList",
        attrs: { blockId: "ol-start", start: 5 },
        content: [{
          type: "listItem",
          attrs: { blockId: "ol-start-item" },
          content: [{
            type: "paragraph",
            attrs: { blockId: "ol-start-p" },
            content: [{ type: "text", text: "第五项" }],
          }],
        }],
      }],
    });
    const editor = new Editor({
      extensions: createQingagentExtensions(),
      content: html,
    });

    try {
      expect(editor.getJSON().content?.[0]?.attrs?.start).toBe(5);
      expect(safeParsePmDoc(editor.getJSON()).success).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  it("剪贴板 HTML 往返保留列表样式、文本对齐与链接 title", async () => {
    const { Editor } = await import("@tiptap/core");
    const { createQingagentExtensions } = await import("../tiptap/createQingagentExtensions");
    const html = pmToClipboardHtml({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "heading",
          attrs: { blockId: "aligned-heading", level: 2, textAlign: "center" },
          content: [{
            type: "text",
            text: "标题",
            marks: [{ type: "link", attrs: { href: "https://example.com", title: "站点提示" } }],
          }],
        },
        {
          type: "paragraph",
          attrs: { blockId: "aligned-p", textAlign: "justify" },
          content: [{ type: "text", text: "两端对齐" }],
        },
        {
          type: "orderedList",
          attrs: { blockId: "styled-list", start: 3, listStyle: "upper-roman" },
          content: [{
            type: "listItem",
            attrs: { blockId: "styled-list-item" },
            content: [{
              type: "paragraph",
              attrs: { blockId: "styled-list-p" },
              content: [{ type: "text", text: "第三项" }],
            }],
          }],
        },
      ],
    });
    const editor = new Editor({
      extensions: createQingagentExtensions(),
      content: html,
    });

    try {
      const content = editor.getJSON().content ?? [];
      expect(content[0]?.attrs?.textAlign).toBe("center");
      expect(content[0]?.content?.[0]?.marks?.[0]?.attrs?.title).toBe("站点提示");
      expect(content[1]?.attrs?.textAlign).toBe("justify");
      expect(content[2]?.attrs).toMatchObject({ start: 3, listStyle: "upper-roman" });
      expect(safeParsePmDoc(editor.getJSON()).success).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  it("含 penNote 的 PM 文档可被 runtime schema 装载", async () => {
    const { getSchema } = await import("@tiptap/core");
    const { Node: PMNode } = await import("@tiptap/pm/model");
    const { createQingagentExtensions } = await import("../tiptap/createQingagentExtensions");
    const schema = getSchema(createQingagentExtensions());
    const doc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "penNote",
          attrs: { blockId: "block-note" },
          content: [{ type: "text", text: "舞台提示:灯光渐暗" }],
        },
      ],
    };
    // 装载失败会 throw(p02 现场即 Unknown node type: penNote)。
    const node = PMNode.fromJSON(schema, doc);
    expect(node.childCount).toBe(1);
    expect(node.firstChild?.type.name).toBe("penNote");
  });
});
