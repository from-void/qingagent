import { describe, expect, it } from "vitest";
import type { FolderSourceOperationResult } from "@qingagent/contract-ts";
import {
  buildAttachFolderCommand,
  matchesAttachFolderResult,
  type FolderAttachSelection,
} from "./folderAttach";

function browserSelection(
  clientSourceId: string,
  handleName: string,
): FolderAttachSelection {
  return {
    provider: "browser-fs-access",
    picked: {
      clientSourceId,
      browserHandleKey: `handle-${clientSourceId}`,
      name: handleName,
      handle: { kind: "directory", name: handleName } as FileSystemDirectoryHandle,
    },
  };
}

function attachSuccess(
  requestId: string,
  clientSourceId: string,
  folderId: string,
): FolderSourceOperationResult {
  return {
    ok: true,
    op: "attach",
    requestId,
    clientSourceId,
    folderId,
  };
}

describe("folder attach receipt correlation", () => {
  it("attach 命令携带本次请求 id 与浏览器 client id", () => {
    const selection = browserSelection("client-a", "folder-a");

    expect(
      buildAttachFolderCommand("session-a", selection, "request-a"),
    ).toMatchObject({
      kind: "attachFolder",
      data: {
        sessionId: "session-a",
        requestId: "request-a",
        source: {
          provider: "browser-fs-access",
          clientSourceId: "client-a",
        },
      },
    });
  });

  it("并发 attach 只消费 requestId 与 clientId 都属于自己的回执", () => {
    const first = browserSelection("client-a", "folder-a");
    const second = browserSelection("client-b", "folder-b");
    const firstReceipt = attachSuccess("request-a", "client-a", "folder-a");

    expect(matchesAttachFolderResult(firstReceipt, "request-a", first)).toBe(
      true,
    );
    expect(matchesAttachFolderResult(firstReceipt, "request-b", second)).toBe(
      false,
    );
    expect(matchesAttachFolderResult(firstReceipt, "request-a", second)).toBe(
      false,
    );
  });
});
