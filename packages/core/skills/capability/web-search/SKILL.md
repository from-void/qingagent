---
name: web-search
label: 联网搜
summary: 搜资料、核事实、找出处
icon: search
description: 联网调研话题：在动笔前或写作过程中搜索网页，核实事实、查找最新信息、寻找可引用的来源。当需求涉及时效性信息、具体数据/事实、你不确定的领域知识，或明确要求"查一下/搜一下/找资料"时使用。返回标题+链接+摘要。
license: MIT
user-invocable: true
placeholder: 搜索主题
config: search-provider
tools: [webSearch]
metadata:
  category: capability
---

# 联网搜索（Web Search）

用免费的 DuckDuckGo 搜索为写作做调研。无需 API key。

## 什么时候搜索
- 主题涉及**时效性**信息（新闻、价格、版本、近期事件）。
- 需要**具体事实/数据/引用**而你不确定。
- 用户明确要"查一下/搜一下/找些资料/看看别人怎么写"。
- 写作前**背景调研**：先搜 1-2 次摸清轮廓再动笔。
不要为常识、纯创意或纯改写搜索——拖慢且无价值。

## 怎么用
1. 用**简短聚焦**的关键词查询；一次不够换词再查，最多 2-3 次。
2. 返回 `results: [{title,url,snippet}]`；先读 snippet 判断哪些值得深入。
3. **需要全文**时对感兴趣的 `url` 调 `fetchArticle`，之后**务必 `storeMaterial`** 存为素材。
4. **引用来源**：以"据 <来源标题>（<url>）"标注，勿把摘要当原创结论抛出。

## 失败处理
- `results` 为空 = 被限流或无结果：换更通用关键词重试一次；仍空则**如实告知"暂时没搜到"**，
  用 `askUserQuestion` 让用户选择“基于已有信息继续”或“停止”；若需要用户补充具体资料或链接，
  应在聊天内明确索取，不能把任意文本伪装成选择题。
- **绝不**编造 URL 或把失败伪装成搜到了。

## 与其他工具的关系
- `webSearch` 只给"线索列表"。要正文 → `fetchArticle`（单 URL）→ `storeMaterial`（存档）。
- 用户直接给了链接 → 跳过 `webSearch`，直接 `fetchArticle`。
