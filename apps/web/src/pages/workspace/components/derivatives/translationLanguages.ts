export const TRANSLATION_LANGUAGES = [
  "英语", "日语", "韩语", "繁体中文", "法语", "德语", "西班牙语", "葡萄牙语", "意大利语", "俄语",
  "阿拉伯语", "泰语", "越南语", "印尼语", "马来语", "印地语", "土耳其语", "荷兰语", "波兰语", "瑞典语",
] as const;

export const MAX_TRANSLATION_LANGUAGES = 5;

/** 新建翻译只提供尚未生成的语种；已有语种继续从译稿页走「重新生成」。 */
export function availableTranslationLanguages(
  generatedLanguages: readonly (string | null | undefined)[] = [],
): string[] {
  const generated = new Set(generatedLanguages.filter(
    (language): language is string => typeof language === "string" && language.length > 0,
  ));
  return TRANSLATION_LANGUAGES.filter((language) => !generated.has(language));
}
