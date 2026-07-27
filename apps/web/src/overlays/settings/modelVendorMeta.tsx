// 厂商卡文案与档位元数据。两家厂商并列成卡,档位挂在厂商名右侧 chip。
// 价格是"约值",仅用于让用户先有量级感;真实计费以厂商账单为准。
import type { ReactNode } from "react";
import type { ModelProvider, ModelTier } from "./visitorKeyStore";

export const MODEL_VENDORS: readonly ModelProvider[] = ["deepseek", "kimi"] as const;
export const MODEL_TIERS: readonly ModelTier[] = ["flash", "pro"] as const;

interface VendorTierMeta {
  name: string;
  desc: string;
}

interface VendorMeta {
  /** 卡片标题与文案里出现的厂商名 */
  name: string;
  /** 零配置态是否带「推 荐」标 */
  recommended: boolean;
  /** 是否有余额体系(只有 DeepSeek 有,卡内才显示余额) */
  hasBalance: boolean;
  tiers: Record<ModelTier, VendorTierMeta>;
}

export const VENDOR_META: Record<ModelProvider, VendorMeta> = {
  deepseek: {
    name: "DeepSeek",
    recommended: true,
    hasBalance: true,
    tiers: {
      flash: { name: "Flash", desc: "快 · 日常写作 · 约¥0.16/篇" },
      pro: { name: "Pro", desc: "更强更慢 · 复杂长稿 · 约¥0.41/篇" },
    },
  },
  kimi: {
    name: "Kimi",
    recommended: false,
    hasBalance: false,
    tiers: {
      flash: { name: "K2.7", desc: "均衡 · 约¥0.20/篇" },
      pro: { name: "K3", desc: "更强 · 约¥0.35/篇" },
    },
  },
};

/** 零配置态卡内的模型介绍(强调段用 em,走暖金色) */
export const VENDOR_INTRO: Record<ModelProvider, ReactNode> = {
  deepseek: (
    <>
      国产旗舰,长文写作能力强,<em>价格最低(约¥0.16/篇)</em>;不支持看图(无多模态)。
    </>
  ),
  kimi: (
    <>
      支持多模态,<em>能看图理解配图</em>;价格略高(约¥0.20/篇起)。已有 Kimi 账号可直接接入。
    </>
  ),
};

export function vendorName(provider: ModelProvider): string {
  return VENDOR_META[provider].name;
}

export function tierName(provider: ModelProvider, tier: ModelTier): string {
  return VENDOR_META[provider].tiers[tier].name;
}

/** 首字母大写的 provider 片段,用于拼 data-wf(ModelTierDeepseekFlash 等) */
export function providerWfKey(provider: ModelProvider): string {
  return provider === "kimi" ? "Kimi" : "Deepseek";
}
