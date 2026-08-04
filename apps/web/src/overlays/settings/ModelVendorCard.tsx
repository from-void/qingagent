import { ModelTierChip } from "./ModelTierChip";
import {
  VENDOR_INTRO,
  VENDOR_META,
  providerWfKey,
} from "./modelVendorMeta";
import { fmtMoney } from "./modelUsage";
import type { CustomProvider, ModelProvider, ModelTier } from "./visitorKeyStore";

interface ModelVendorCardProps {
  provider: ModelProvider;
  vendorStateKnown: (provider: ModelProvider) => boolean;
  vendorConfigured: (provider: ModelProvider) => boolean;
  effectiveProvider: ModelProvider;
  customProviders: Record<ModelProvider, CustomProvider | null>;
  balanceVal?: { currency: string; total: string; granted: string; toppedUp: string };
  deepseekStatus: { tone: "ok" | "bad" | "idle"; text: string };
  kimiConnected: boolean;
  tiers: Record<ModelProvider, ModelTier>;
  persisting: boolean;
  handleModelTierChange: (provider: ModelProvider, tier: ModelTier) => Promise<void>;
  lowBalance: boolean;
  estDocs: number | null;
  handleProviderChange: (provider: ModelProvider, silent?: boolean) => Promise<boolean>;
  openConfig: (provider: ModelProvider) => void;
}
export function ModelVendorCard({
  provider,
  vendorStateKnown,
  vendorConfigured,
  effectiveProvider,
  customProviders,
  balanceVal,
  deepseekStatus,
  kimiConnected,
  tiers,
  persisting,
  handleModelTierChange,
  lowBalance,
  estDocs,
  handleProviderChange,
  openConfig,
}: ModelVendorCardProps) {
    const meta = VENDOR_META[provider];
    const wf = providerWfKey(provider);
    const stateKnown = vendorStateKnown(provider);
    const configuredVendor = vendorConfigured(provider);
    // 使用中按 effectiveProvider 判定:配置了模型却没有任何一家在使用是非法态,
    // 只配了一家时那家必然「使用中」,不会出现无处可切的「启 用」按钮。
    const isActive = configuredVendor && effectiveProvider === provider;
    const vendorCustom = customProviders[provider];
    const balanceText = balanceVal
      ? balanceVal.currency === "CNY"
        ? fmtMoney(Number(balanceVal.total))
        : `${balanceVal.currency} ${Number(balanceVal.total).toFixed(2)}`
      : null;
    // 卡内状态行:DeepSeek 走自动余额检测;Kimi 无余额体系,连通只在二级页手动测。
    const cardStatus = vendorCustom
      ? { tone: "ok" as const, text: "已接入自定义模型" }
      : provider === "deepseek"
        ? deepseekStatus
        : { tone: "ok" as const, text: kimiConnected ? "已连通" : "已配置" };

    return (
      <div
        key={provider}
        className={`md-card vd-card${isActive ? " vd-card--on" : ""}`}
        data-wf={`ModelVendorCard${wf}`}
        aria-busy={stateKnown ? undefined : true}
      >
        <div className="vd-head">
          <img
            className={`vd-logo${meta.logoBoxed ? " vd-logo--boxed" : ""}`}
            src={meta.logo}
            alt=""
            aria-hidden="true"
          />
          <span className="md-card-title">{meta.name}</span>
          {!stateKnown ? null : configuredVendor ? (
            <ModelTierChip
              provider={provider}
              tier={tiers[provider]}
              disabled={persisting}
              onChange={(tier) => void handleModelTierChange(provider, tier)}
            />
          ) : meta.recommended ? (
            <i className="sk-card-tag">推 荐</i>
          ) : null}
        </div>

        {/* server 首拉未回来且本机也判不出配置态时,卡内主体先留空——
            宁可空 30ms,也不闪一帧「去配置 / 未配置介绍」再被服务端 key 顶掉。 */}
        {!stateKnown ? null : configuredVendor ? (
          <>
            <div className="md-status-row">
              <span className={`md-dot md-dot--${cardStatus.tone}`} aria-hidden="true" />
              <span className="md-status-text">
                {cardStatus.text}
                {meta.hasBalance && !vendorCustom && balanceText ? (
                  <>
                    {" · 余额 "}
                    <span className="font-mono">{balanceText}</span>
                  </>
                ) : null}
              </span>
            </div>
            {meta.hasBalance && !vendorCustom && lowBalance && (
              <span className="md-metric-warn">
                <span className="md-dot md-dot--warn" aria-hidden="true" />
                余额偏低，建议及时充值
              </span>
            )}
            {meta.hasBalance && !vendorCustom && estDocs != null && (
              <span className="vd-note">按当前均价,余额约还能写 {Math.floor(estDocs)} 篇</span>
            )}
          </>
        ) : (
          <p className="vd-intro">{VENDOR_INTRO[provider]}</p>
        )}

        {!stateKnown ? null : configuredVendor ? (
          isActive ? (
            <button
              type="button"
              className="sm-btn vd-cta vd-cta--using"
              disabled
              data-wf={`ModelUsing${wf}`}
            >
              使用中
            </button>
          ) : (
            <button
              type="button"
              className="sm-btn vd-cta"
              onClick={() => void handleProviderChange(provider)}
              disabled={persisting}
              data-wf={`ModelEnable${wf}`}
            >
              启 用
            </button>
          )
        ) : (
          <button
            type="button"
            className={`sm-btn vd-cta${meta.recommended ? " vd-cta--rec" : ""}`}
            onClick={() => openConfig(provider)}
            disabled={persisting}
            data-wf={`ModelConfig${wf}`}
          >
            去配置
          </button>
        )}

        {stateKnown && configuredVendor && (
          <span className="md-keyops vd-cfg">
            <button
              type="button"
              className="md-mini-btn"
              onClick={() => openConfig(provider)}
              disabled={persisting}
              data-wf={`ModelConfig${wf}`}
            >
              配 置
            </button>
          </span>
        )}
      </div>
    );
}
