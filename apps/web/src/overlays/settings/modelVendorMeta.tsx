// 厂商卡文案与档位元数据。两家厂商并列成卡,档位挂在厂商名右侧 chip。
// 一律不写具体单价:厂商随时调价,写死的数字会过期误导;只给定性特点与相对贵贱。
import type { ReactNode } from "react";
import deepseekLogo from "../../assets/vendor/deepseek.png";
import kimiLogo from "../../assets/vendor/kimi.png";
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
  /** 官方 logo(卡头厂商名左侧) */
  logo: string;
  /** 深底方块型 logo 需要切个小圆角,透明底的不需要 */
  logoBoxed: boolean;
  /** 零配置态是否带「推 荐」标 */
  recommended: boolean;
  /** 是否有余额体系(只有 DeepSeek 有,卡内才显示余额) */
  hasBalance: boolean;
  tiers: Record<ModelTier, VendorTierMeta>;
}

export const VENDOR_META: Record<ModelProvider, VendorMeta> = {
  deepseek: {
    name: "DeepSeek",
    logo: deepseekLogo,
    logoBoxed: false,
    recommended: true,
    hasBalance: true,
    tiers: {
      flash: { name: "Flash", desc: "便宜、速度快 · 日常写作" },
      pro: { name: "Pro", desc: "效果更好,费用更高、耗时久一点 · 复杂长稿" },
    },
  },
  kimi: {
    name: "Kimi",
    logo: kimiLogo,
    logoBoxed: true,
    recommended: false,
    hasBalance: false,
    tiers: {
      flash: { name: "K2.7", desc: "相对便宜、均衡" },
      pro: { name: "K3", desc: "Kimi 当前最强的模型,也最贵" },
    },
  },
};

/** 零配置态卡内的模型介绍(强调段用 em,走暖金色) */
export const VENDOR_INTRO: Record<ModelProvider, ReactNode> = {
  deepseek: (
    <>
      国产旗舰,长文写作能力强,<em>写作成本最低</em>;支持图片识别(实验版)。
    </>
  ),
  kimi: (
    <>
      支持多模态,<em>能看图理解配图</em>;价格比 DeepSeek 略高。已有 Kimi 账号可直接接入。
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
