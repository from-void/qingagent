import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildEditContextMenuTemplate,
  type EditContextMenuParams,
} from "./contextMenu.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const defaultEditFlags: EditContextMenuParams["editFlags"] = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canDelete: false,
  canSelectAll: false,
  canEditRichly: false,
};

function makeParams(
  overrides: Partial<Omit<EditContextMenuParams, "editFlags">> & {
    editFlags?: Partial<EditContextMenuParams["editFlags"]>;
  } = {},
): EditContextMenuParams {
  return {
    isEditable: false,
    selectionText: "",
    ...overrides,
    editFlags: {
      ...defaultEditFlags,
      ...overrides.editFlags,
    },
  };
}

function enabledStates(params: EditContextMenuParams): boolean[] {
  return buildEditContextMenuTemplate(params).map((item) => item.enabled ?? true);
}

test("右键菜单只含中文剪切、复制、粘贴、全选四项及对应原生 role", () => {
  const template = buildEditContextMenuTemplate(makeParams());

  assert.equal(template.length, 4);
  assert.deepEqual(
    template.map(({ label, role }) => ({ label, role })),
    [
      { label: "剪切", role: "cut" },
      { label: "复制", role: "copy" },
      { label: "粘贴", role: "paste" },
      { label: "全选", role: "selectAll" },
    ],
  );
});

test("可编辑区域有选区且 editFlags 允许时四项均启用", () => {
  assert.deepEqual(
    enabledStates(makeParams({
      isEditable: true,
      selectionText: "已选文本",
      editFlags: {
        canCut: true,
        canCopy: true,
        canPaste: true,
        canSelectAll: true,
      },
    })),
    [true, true, true, true],
  );
});

test("普通页面有选区时仅按 editFlags 启用复制与全选", () => {
  assert.deepEqual(
    enabledStates(makeParams({
      selectionText: "页面选区",
      editFlags: {
        canCut: true,
        canCopy: true,
        canPaste: true,
        canSelectAll: true,
      },
    })),
    [false, true, false, true],
  );
});

test("可编辑区域无选区时禁用剪切复制，保留粘贴与全选", () => {
  assert.deepEqual(
    enabledStates(makeParams({
      isEditable: true,
      editFlags: {
        canCut: true,
        canCopy: true,
        canPaste: true,
        canSelectAll: true,
      },
    })),
    [false, false, true, true],
  );
});

test("editFlags 拒绝的操作即使上下文满足也保持禁用", () => {
  assert.deepEqual(
    enabledStates(makeParams({
      isEditable: true,
      selectionText: "已选文本",
    })),
    [false, false, false, false],
  );
});

test("右键菜单事件只注册到主窗口，确认模态窗与 PDF 离屏窗均不注册", () => {
  const mainSource = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const pdfRendererSource = readFileSync(path.join(__dirname, "pdfRenderer.ts"), "utf8");
  const registrations = mainSource.match(/\.webContents\.on\("context-menu"/g) ?? [];

  assert.equal(registrations.length, 1);
  assert.match(mainSource, /mainWindow\.webContents\.on\("context-menu"/);
  assert.doesNotMatch(mainSource, /promptWindow\.webContents\.on\("context-menu"/);
  assert.doesNotMatch(pdfRendererSource, /\.webContents\.on\("context-menu"/);
});
