export interface SuggestionEntry {
  title: string;
  /** The text inserted into the starter input when picked. */
  text: string;
}

export const NEW_SESSION_SUGGESTIONS: SuggestionEntry[] = [
  {
    title: "即兴写作",
    text: "帮我写一篇1000字的散文,题目是春天,主要描述杭州春天的美丽,文笔可以参考朱自清",
  },
  {
    title: "查资料写稿",
    text: "帮我查一下最新的关于 AI 领域的新闻,并撰写一份1500字的新闻稿。",
  },
  {
    title: "链接读取",
    text: "帮我分析提炼总结一下该篇公众号文章的写作风格 https://mp.weixin.qq.com/s/UZSCNuWOOnGincyS-ODftw",
  },
  {
    title: "文件解析",
    text: "帮我将该 PDF 提炼总结为一篇1500字的文章。",
  },
];
