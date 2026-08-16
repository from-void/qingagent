import "./modelDashboard.css";
import {
  MODEL_VENDORS,
  vendorName,
} from "./modelVendorMeta";
import { ensureSettingsDialogA11y } from "./settingsDialogA11y";
import { ModelConfigurationView } from "./ModelConfigurationView";
import { ModelUsageDashboard } from "./ModelUsageDashboard";
import { ModelUsageDetails } from "./ModelUsageDetails";
import { ModelVendorCard } from "./ModelVendorCard";
import { PENDING_SUB } from "./modelSettingsTypes";
import { type ModelProvider } from "./visitorKeyStore";
import { useModelSettingsPanel } from "./useModelSettingsPanel";
import { attachCapabilityEnabled } from "../../system/backendConnectionStore";

ensureSettingsDialogA11y();

// F1 模型设置面板。两层 key:本浏览器(visitor,localStorage) / 站点全局兜底(global-db)。
export function ModelSettingsPanel({
  initialConfigProvider,
}: {
  initialConfigProvider?: ModelProvider;
} = {}) {
  const controller = useModelSettingsPanel(initialConfigProvider);
  const {
    view, serverSettled, customProviders, kimiConnected, persisting, tiers,
    usageView, usageMode, expandedUsageGroups, usageSettled, usageStatus,
    usageDate, setUsageDate, handleProviderChange, openConfig,
    vendorConfigured, vendorStateKnown, anyConfigured, effectiveProvider,
    handleModelTierChange, recent, docStats, modelDist, trend, scheduleRevision,
    dashboardReady, showDashboardLoading, showUsageLoading, todayYmd, usageDates,
    usageDateUnsupported, usageModelIds, selectedModelIds, allModelsSelected,
    filteredUsage, usageGroups, toggleUsageModel, selectAllUsageModels,
    toggleUsageMode, switchUsageView, toggleUsageGroup, deepseekStatus,
    balanceVal, lowBalance, docs7, words7, avgPerDoc, docsPer10, estDocs,
  } = controller;
  const modelKeysEnabled = attachCapabilityEnabled("modelKeys");

  return (
    <fieldset
      className="settings-model"
      data-wf="ModelSettingsPanel"
      disabled={!modelKeysEnabled}
      aria-describedby={!modelKeysEnabled ? "attach-model-config-note" : undefined}
    >
      {!modelKeysEnabled ? (
        <p id="attach-model-config-note" className="sm-keyhint">
          当前使用外部后台的模型配置；桌面端不会读取或转交本机密钥。
        </p>
      ) : null}
      {view === "config" ? (
        <ModelConfigurationView controller={controller} />
      ) : (
        <section className="sm-configured">
          {/* 「还没有可用的模型」只在 server 首拉 settled 后才敢下结论——
              否则站点全局 / env 配的 key 还没回来就先闪一条错误引导(真机闪帧实证)。 */}
          {serverSettled && !anyConfigured && (
            <div className="vd-onboard" data-wf="ModelOnboardHint">
              还没有可用的模型。<b>推荐先接 DeepSeek</b>——写作最便宜;需要模型看图再接 Kimi。配置任意一家即可开始写作。
            </div>
          )}

          <div className="vd-grid" data-wf="ModelVendorCards">
            {MODEL_VENDORS.map((provider) => (
              <ModelVendorCard
                key={provider}
                provider={provider}
                vendorStateKnown={vendorStateKnown}
                vendorConfigured={vendorConfigured}
                effectiveProvider={effectiveProvider}
                customProviders={customProviders}
                balanceVal={balanceVal}
                deepseekStatus={deepseekStatus}
                kimiConnected={kimiConnected}
                tiers={tiers}
                persisting={persisting}
                handleModelTierChange={handleModelTierChange}
                lowBalance={lowBalance}
                estDocs={estDocs}
                handleProviderChange={handleProviderChange}
                openConfig={openConfig}
              />
            ))}
          </div>
          <ModelUsageDashboard
            recent={recent}
            docStats={docStats}
            docs7={docs7}
            words7={words7}
            avgPerDoc={avgPerDoc}
            docsPer10={docsPer10}
            dashboardReady={dashboardReady}
            showDashboardLoading={showDashboardLoading}
            modelDist={modelDist}
            trend={trend}
            pendingSub={PENDING_SUB}
          />

          <ModelUsageDetails
            usageMode={usageMode}
            toggleUsageMode={toggleUsageMode}
            usageView={usageView}
            usageDate={usageDate}
            todayYmd={todayYmd}
            usageDates={usageDates}
            setUsageDate={setUsageDate}
            usageModelIds={usageModelIds}
            selectedModelIds={selectedModelIds}
            toggleUsageModel={toggleUsageModel}
            selectAllUsageModels={selectAllUsageModels}
            allModelsSelected={allModelsSelected}
            switchUsageView={switchUsageView}
            usageDateUnsupported={usageDateUnsupported}
            usageSettled={usageSettled}
            showUsageLoading={showUsageLoading}
            usageStatus={usageStatus}
            filteredUsage={filteredUsage}
            usageGroups={usageGroups}
            expandedUsageGroups={expandedUsageGroups}
            toggleUsageGroup={toggleUsageGroup}
            scheduleRevision={scheduleRevision}
          />
        </section>
      )}
    </fieldset>
  );
}
