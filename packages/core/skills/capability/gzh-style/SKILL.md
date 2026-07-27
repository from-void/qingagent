---
name: gzh-style
label: 公众号风格
icon: style
summary: 学习、创建和维护公众号排版与写作风格
description: 用户要从公众号文章学习风格，或查看、新建、修改、删除公众号排版/写作模板时使用。
user-invocable: true
tools: [fetchArticle, askUserQuestion, style_template_list, style_template_get, style_template_save, style_template_delete]
metadata:
  category: capability
  platform: wechat
---

# 公众号风格模板

## 从文章学习风格

1. 用户给出 `mp.weixin.qq.com` 链接并要求“学风格/按这个排版”时，先用 `fetchArticle` 抓取；它已内置微信正文清洗。
2. 分开分析两类提示词：排版侧提取高亮颜色、标题字号与层级、段落长度和小节节奏；写作侧提取语气、内容组织、开头、论证和结尾策略。不要把文章事实写进模板。
3. 调 `style_template_list` 列出现有同槽模板。
4. 必须单独调用 `askUserQuestion`，询问“融合进现有模板”还是“新建模板”，并把现有模板作为可选项；等待用户选择，不替用户决定。
5. 用户选择后调用 `style_template_save`：融合时带现有 id 且保留其有效规则；新建时不传 id。排版与写作都要学习时分别保存两个槽。
6. 简短回报保存的模板名称、槽位和是新增还是更新。

## 模板 CRUD

- 查看清单用 `style_template_list`，看完整规则用 `style_template_get`。
- 新建或修改用 `style_template_save`；`slot=layout` 只写排版规则，`slot=writing` 只写内容写法。
- 删除用 `style_template_delete`；内置模板不可删。修改内置模板后会自动转为用户模板语义。
