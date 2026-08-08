// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelUsageDashboard } from "./ModelUsageDashboard";
import { UsageTableRow, type UsageRow } from "./modelUsage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const row: UsageRow = {
  bucket: "2026-08-08",
  callSite: "agent",
  modelId: "zero-model",
  inputTokens: 100,
  outputTokens: 10,
  cacheHitTokens: 0,
  cacheMissTokens: 100,
  coldStartMissTokens: 100,
  cacheCreationTokens: 0,
  cacheHitRate: 0,
  calls: 6,
  recordedCalls: 3,
  estimatedCalls: 3,
  missingCalls: 0,
  coverageRate: 0.5,
  costCny: 0,
  estimatedCostCny: 0,
  pricedCalls: 2,
  unpricedCalls: 1,
  estimatedPricedCalls: 1,
  estimatedUnpricedCalls: 2,
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("计价覆盖 UI", () => {
  it("零价已计价仍显示，卡片/饼图/趋势/明细四处保留部分计价文案", () => {
    act(() => root.render(<>
      <ModelUsageDashboard
        recent={{
          cost: 0,
          estimatedCost: 0,
          tokens: 110,
          estimatedTokens: 0,
          calls: 6,
          recordedCalls: 3,
          estimatedCalls: 3,
          missingCalls: 0,
          billingUnknownCalls: 0,
          pricedCalls: 2,
          unpricedCalls: 1,
          estimatedPricedCalls: 1,
          estimatedUnpricedCalls: 2,
          coverageRate: 0.5,
        }}
        providerBalance={undefined}
        usageTimeZone="UTC"
        docStats={{ docs: 1, words: 100 }}
        docs7={1}
        words7={100}
        avgPerDoc={0}
        docsPer10={0}
        dashboardReady
        showDashboardLoading={false}
        modelDist={[{
          name: "零价模型",
          tokens: 110,
          cost: 0,
          pct: 0,
          pricedCalls: 2,
          unpricedCalls: 1,
          estimatedPricedCalls: 1,
          estimatedUnpricedCalls: 2,
        }]}
        trend={{
          days: [{
            date: "2026-08-08",
            label: "08-08",
            cost: 0,
            tokens: 110,
            pricedCalls: 2,
            unpricedCalls: 1,
            estimatedPricedCalls: 1,
            estimatedUnpricedCalls: 2,
          }],
          max: 0,
        }}
        pendingSub=""
      />
      <table><tbody>
        <UsageTableRow row={row} label="零价明细" mode="simple" kind="group" />
      </tbody></table>
    </>));

    expect(host.querySelector('[data-wf="UsagePricingCoverageRecent"]')?.textContent)
      .toContain("部分计价");
    expect(host.querySelector('[data-wf="UsagePricingCoverageDistribution"]')?.textContent)
      .toContain("部分计价");
    expect(host.querySelector('[data-wf="UsagePricingCoverageTrend"]')?.getAttribute("aria-label"))
      .toContain("部分计价");
    expect(host.querySelector('[data-wf="UsagePricingCoverage"]')?.textContent)
      .toContain("部分计价");
    expect(host.textContent).toContain("¥0.000");
    expect(host.textContent).toContain("零价模型");
  });
});
