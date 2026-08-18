import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acknowledgeAttachStartupNotice,
  persistBoundLibraryId,
  persistDemotedCrossNamespaceBinding,
  readAttachBindingState,
} from "./attachBindingStore.js";
import { readPrivateStringMap, writePrivateStringMap } from "./privateJsonStore.js";

const BOUND = "00000000-0000-4000-8000-000000000001";

test("跨系统绑定降级会原子清空绑定并记录待展示提示", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qingagent-attach-binding-"));
  const file = path.join(dir, "attach-binding.json");
  writePrivateStringMap(file, { boundLibraryId: BOUND, futureKey: "keep-me" });

  try {
    persistDemotedCrossNamespaceBinding(file, BOUND);
    assert.deepEqual(readAttachBindingState(file), {
      boundLibraryId: null,
      pendingStartupNotice: "cross-namespace-library-demoted",
    });
    assert.deepEqual(readPrivateStringMap(file), {
      pendingCrossNamespaceDemotionNotice: BOUND,
      futureKey: "keep-me",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("提示确认只清待展示标记，不恢复已失效的跨系统绑定", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qingagent-attach-notice-"));
  const file = path.join(dir, "attach-binding.json");

  try {
    persistBoundLibraryId(file, BOUND);
    persistDemotedCrossNamespaceBinding(file, BOUND);
    acknowledgeAttachStartupNotice(file, "cross-namespace-library-demoted");
    assert.deepEqual(readAttachBindingState(file), {
      boundLibraryId: null,
      pendingStartupNotice: null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
