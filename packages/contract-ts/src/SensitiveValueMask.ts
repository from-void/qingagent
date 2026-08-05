import type { AnnotationGroup, SuggestionAnchor } from "./DocSuggestion";

const MOBILE_RE = /(?<!\d)1[3-9]\d(?:[ -]?\d){8}(?!\d)/g;
const TRUNCATED_MOBILE_RE = /(?<!\d)1[3-9]\d{7,8}(?!\d)/g;
const ID_CARD_18_RE = /(?<![\dA-Za-z])[1-8]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dA-Za-z])/g;
const ID_CARD_15_RE = /(?<!\d)[1-8]\d{5}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}(?!\d)/g;
const LONG_NUMBER_RE = /(?<!\d)\d{13,19}(?!\d)/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/gi;

const NUMERIC_NEGATIVE_CONTEXT_RE =
  /(?:订单(?:号|编号)?|项目(?:号|编号)?|合同(?:号|编号)?|快递单号|运单号|流水号|序列号|编号|年份|金额|价格)[ \t]*[：:]?[ \t]*$/;
const ID_CARD_CONTEXT_RE = /(?:身份证(?:号|号码|编号)?|公民身份号码|证件号)[ \t]*[：:]?[ \t]*$/;
const CARD_CONTEXT_RE = /(?:银行卡(?:号|号码|编号)?|信用卡(?:号|号码|编号)?|借记卡(?:号|号码|编号)?|储蓄卡(?:号|号码|编号)?|银联卡?(?:号|号码|编号)?|会员卡(?:号|号码|编号)?|卡号|银行账号)[ \t]*[：:]?[ \t]*$/;

function leftContext(text: string, offset: number): string {
  return text.slice(Math.max(0, offset - 24), offset);
}

function hasNumericNegativeContext(text: string, offset: number): boolean {
  return NUMERIC_NEGATIVE_CONTEXT_RE.test(leftContext(text, offset));
}

function isValidDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function hasValidIdDate(value: string): boolean {
  if (value.length === 18) {
    return isValidDate(Number(value.slice(6, 10)), Number(value.slice(10, 12)), Number(value.slice(12, 14)));
  }
  const shortYear = Number(value.slice(6, 8));
  return isValidDate(1900 + shortYear, Number(value.slice(8, 10)), Number(value.slice(10, 12)));
}

function hasValidIdChecksum(value: string): boolean {
  if (value.length !== 18) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
  const sum = weights.reduce((total, weight, index) => total + Number(value[index]) * weight, 0);
  return checks[sum % 11] === value[17]?.toUpperCase();
}

function passesLuhn(value: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function maskDigits(value: string, head: number, tail: number): string {
  const visibleTail = tail === 0 ? "" : value.slice(-tail);
  return `${value.slice(0, head)}${"*".repeat(value.length - head - tail)}${visibleTail}`;
}

function maskEmail(value: string): string {
  const separator = value.lastIndexOf("@");
  const local = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  const visible = local.length >= 3 ? local.slice(0, 3) : local.length === 2 ? local.slice(0, 1) : "";
  const stars = local.length === 1 ? "*" : local.length === 2 ? "*" : "***";
  return `${visible}${stars}@${domain}`;
}

export function isSensitiveReviewOrigin(origin: string | null | undefined): boolean {
  return origin === "privacy" || origin === "sensitive";
}

export function buildSensitiveAnchorSpanKey(
  anchor: Pick<SuggestionAnchor, "blockId" | "pmFrom" | "pmTo">,
): string {
  return `span:${anchor.blockId}:${anchor.pmFrom}:${anchor.pmTo}`;
}

/**
 * 审查展示与审计副本使用的保守打码器。
 *
 * 严格命中大陆手机号形态时一律处理；业务数字标签只能豁免身份证候选、长数字候选等
 * 低置信形态，不能反压完整手机号。长数字只有在校验通过、命中银行卡号段或紧邻明确
 * 类型标签时才处理，避免破坏普通引用型批注。
 */
export function maskSensitiveValues(input: string): string {
  let output = input.replace(EMAIL_RE, (value) => maskEmail(value));

  output = output.replace(MOBILE_RE, (value) => {
    const digits = value.replace(/[^\d]/g, "");
    return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  });

  output = output.replace(ID_CARD_18_RE, (value, offset: number) => {
    const labeled = ID_CARD_CONTEXT_RE.test(leftContext(output, offset));
    if ((!labeled && hasNumericNegativeContext(output, offset)) || !hasValidIdDate(value)) return value;
    return hasValidIdChecksum(value) || labeled ? maskDigits(value, 3, 4) : value;
  });

  output = output.replace(ID_CARD_15_RE, (value, offset: number) => {
    if (
      !ID_CARD_CONTEXT_RE.test(leftContext(output, offset))
      || !hasValidIdDate(value)
    ) {
      return value;
    }
    return maskDigits(value, 3, 4);
  });

  output = output.replace(LONG_NUMBER_RE, (value, offset: number) => {
    const context = leftContext(output, offset);
    const labeled = CARD_CONTEXT_RE.test(context);
    if (!labeled && hasNumericNegativeContext(output, offset)) return value;
    const looksLikeUnionPay = value.startsWith("62") && value.length >= 16;
    if (!passesLuhn(value) && !looksLikeUnionPay && !labeled) return value;
    return maskDigits(value, 4, 4);
  });

  return output;
}

/**
 * 持久化审查决定专用的二次脱敏。
 *
 * 普通展示链路只识别完整手机号；忽略决定会长期入库并反复进入模型上下文，因此还要兜住
 * 9/10 位、以大陆手机号号段开头的截断片段。完整 11 位形态已无条件处理；截断片段仍允许
 * 同一行紧邻的订单号、项目编号、金额等标签豁免，避免把低置信的正常数字误当成 PII。
 * 其余命中只保留前三位，不保留可与别处拼接的尾数。
 */
export function maskPersistedReviewIgnoreValue(input: string): string {
  const output = maskSensitiveValues(input);
  return output.replace(TRUNCATED_MOBILE_RE, (value, offset: number) => {
    if (hasNumericNegativeContext(output, offset)) return value;
    return maskDigits(value, 3, 0);
  });
}

export function maskSensitiveAnnotationGroup(group: AnnotationGroup): AnnotationGroup {
  if (!isSensitiveReviewOrigin(group.origin)) return group;
  return {
    ...group,
    summary: maskSensitiveValues(group.summary),
    note: maskSensitiveValues(group.note),
    suggestion: group.suggestion === undefined
      ? undefined
      : maskSensitiveValues(group.suggestion),
    anchors: group.anchors.map((anchor) => ({
      ...anchor,
      quote: maskSensitiveValues(anchor.quote),
      // 打码值配原文哈希可被低熵穷举还原；敏感类批注只持久化结构定位键。
      textHash: buildSensitiveAnchorSpanKey(anchor),
    })),
  };
}
