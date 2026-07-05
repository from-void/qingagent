---
name: doc-calc
label: 算数据
summary: 表格统计与精确计算
icon: calc
description: 文档数据精确计算——当写作涉及表格求和、求平均、统计、财务汇总等需要精确数字时使用。不要心算大量数字，而是用 run_js 或本技能自带的零依赖计算脚本算准，再把结果写进文档。
user-invocable: true
placeholder: 粘贴数据
tools: [run_js]
metadata:
  category: capability
---

# 算数据

当写作涉及求和、平均、统计、财务合计、表格汇总等精确数字时，不要心算，也不要凭感觉估。先把数据整理成可计算输入，用 `run_js` 或本技能自带沙箱脚本算出准确结果，再写进文档。

## 何时使用

- 用户给出表格、清单或多组数字，要求算总计、合计、平均值、最大最小值、占比、同比环比等。
- 财务、预算、报表、投研、经营分析类文档中出现关键数字。
- 草稿里需要把素材中的数值汇总成一句准确结论。
- 数字较多、位数较长或包含货币符号、千分位、百分比，心算容易出错。

## 首选方式：用 run_js 精确计算

少量或结构清晰的数据，直接调用 `run_js`。把数字作为数组或对象写清楚，让代码返回 JSON 结果。

示例：

```js
const values = [1280, 960, 430, 1875];
const sum = values.reduce((acc, n) => acc + n, 0);
return { count: values.length, sum, avg: sum / values.length };
```

写回文档时只使用计算结果，不要再改成心算值。

## 复杂输入：用自带脚本

本技能保留零依赖脚本 `scripts/calc.mjs`，适合 CSV、多行文本、按列求和等场景。需要先用 `skill_read` 查看脚本或由系统注入技能目录路径，再在沙箱内运行。

常用形态：

```bash
node <技能目录>/scripts/calc.mjs sum --json '[1280, 960, 430, 1875]'
node <技能目录>/scripts/calc.mjs stats --json '[12, 34, 56]'
node <技能目录>/scripts/calc.mjs sumcol 1 --file /workspace/table.csv
```

脚本返回 JSON；若返回 `{"error": ...}`，修正输入后再算，不要编造结果。

## 纪律

1. 先从用户输入、文档或素材中抽取数字，并保留单位、币种、口径。
2. 能用 `run_js` 一次算清的，优先用 `run_js`。
3. 数据多或是 CSV/多行文本时，写入工作区文件后用 `scripts/calc.mjs`。
4. 把计算结果连同口径写进文档，例如“按表中 4 项费用合计为 4545 元”。
5. 不要为了“看起来合理”改计算结果；不确定口径时先问用户。
6. 不使用管道或重定向喂数据，避免沙箱拒绝命令。
