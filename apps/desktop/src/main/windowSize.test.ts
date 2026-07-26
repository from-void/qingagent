import assert from "node:assert/strict";
import { test } from "node:test";
import { computeMainWindowSize } from "./windowSize.js";

const CASES = [
  { workAreaWidth: 1280, expectedWidth: 1242 },
  { workAreaWidth: 1440, expectedWidth: 1380 },
  { workAreaWidth: 1512, expectedWidth: 1380 },
  { workAreaWidth: 1728, expectedWidth: 1480 },
  { workAreaWidth: 1920, expectedWidth: 1480 },
  { workAreaWidth: 2560, expectedWidth: 1480 },
] as const;

for (const { workAreaWidth, expectedWidth } of CASES) {
  test(`工作区宽 ${workAreaWidth} 时主窗口宽度为 ${expectedWidth}`, () => {
    assert.deepEqual(computeMainWindowSize(workAreaWidth, 900), {
      width: expectedWidth,
      height: 828,
    });
  });
}
