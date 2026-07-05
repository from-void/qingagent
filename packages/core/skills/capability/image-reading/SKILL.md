---
name: image-reading
label: 看图片
summary: 识别图片内容与文字
icon: vision
description: 识别、描述或提取用户提供的单张图片内容。用户上传图片、给出图片链接、给出 fileId,或要求 OCR/看图分析/图片转文字/描述图片时使用。
user-invocable: true
placeholder: 上传图片或说明
config: vision-provider
tools: [readImage]
metadata:
  category: capability
---

# 图像识别

你可以调用 `readImage` 读取用户提供的单张图片,把识别结果作为文字返回后再继续写作或回答。

## 何时使用

- 用户上传了图片,并要求描述、识别、提取文字、分析版式、总结图片信息。
- 用户给出 http(s) 图片链接。
- 当前文档正文里已有图片,需要理解它。
- 素材区里有图片素材,需要识别其内容。

不要用于生成图片、改图、制作插图;这些场景使用其他工具。

## 五类图片来源 → 给 `image` 传什么

1. **http(s) 图片链接**(用户在对话里贴的):直接把该 URL 传给 `image`。
2. **刚上传还没解析的文件**:用系统提示给你的 `filePath`(`/api/v1/files/<id>/<name>`)或裸 `fileId`。
3. **文档正文里已有的图片**:先 `readDraft` 读到该图片块,取它的 `src`(可能是 `/api/v1/files/...`、http(s) 或 `data:image/...;base64,...`),原样传给 `image`。
4. **素材区的图片素材**:把该素材的 `materialId` 传给 `image`,工具会自动取该素材的原始图片字节(非图片素材会报错)。
5. **飞书等外部文档里的图片**:先用 feishu 技能(lark-cli,如 `docs +media-download`)把图片下载到工作区,再用 `read_file` 以 `encoding:"base64"` 读出,拼成 `data:image/<类型>;base64,<内容>` 传给 `image`。

## 如何调用

调用 `readImage`:

- `image`: 见上面五类来源,传对应的 URL / 路径 / fileId / materialId / data URL。
- `prompt`: 本次识别任务指令。写清楚要提取什么,例如"请提取图片中的中文文字并保留换行"。
- `includeConversation`: 默认不传或传 `false`;只有图片含义必须结合最近对话才看得懂时传 `true`。

工具返回:

- `ok: true` 时,`text` 是识别结果。基于它继续回答用户。
- `ok: false` 时,`error` 是失败原因。若提示"图像识别副基模未配置",请让用户到"设置 → 技能 → 图像识别"填写多模态模型 API key。

## 约束

- 一次只读一张图;多图时逐张调用。
- 远程图片只把链接交给后端工具读取,不要把第三方图片 URL 当作前端缩略图展示。
- 除非必要,不要把最近对话发给图像识别副基模。
