import { RequestContext } from "@mastra/core/request-context";
import { streamText } from "ai";
import { Buffer } from "node:buffer";
import {
  getVisionModel,
  MODEL_OVERRIDES_CONTEXT_KEY,
  type ModelOverrides,
} from "./modelConfig.js";

export const VISION_TEST_TIMEOUT_MS = 12_000;

// 32×32 棋盘小图(非 1×1):部分多模态模型(如 GLM-4.6V)会拒收 1×1 退化图,
// 用稍大的真实图做连通性测试更稳,避免合法配置假阴性。
const VISION_TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAASElEQVR4nGPQsFkARycqbOCIWuIMoxYQtIAWhiKLj1pA2IKhn4qGvgVDPxUNfQuGfioa+hYM/VQ09C0Y+qlo6Fsw9FPRkLcAAPrfAEzM8AdWAAAAAElFTkSuQmCC",
  "base64",
);

export async function testVisionConnection(vision: NonNullable<ModelOverrides["vision"]>): Promise<void> {
  const entries: Iterable<readonly [string, unknown]> = [
    [
      MODEL_OVERRIDES_CONTEXT_KEY,
      { vision },
    ],
  ];
  const requestContext = new RequestContext<unknown>(entries);
  const visionModel = await getVisionModel(requestContext);
  if (!visionModel) {
    throw new Error("图像识别配置未生效");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TEST_TIMEOUT_MS);
  try {
    const result = streamText({
      model: visionModel,
      maxTokens: 16,
      maxRetries: 0,
      toolChoice: "none",
      abortSignal: controller.signal,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "这是一张连通性测试图片。请只回答 ok。" },
            { type: "image", image: VISION_TEST_PNG, mimeType: "image/png" },
          ],
        },
      ],
    });
    // 必须用 fullStream:textStream 在上游报错(401 鉴权 / 非 API 端点 / 协议不匹配 / 限流)时
    // 会静默结束、不抛,导致把失败的连通性测试当成功(ok:true 假阳性)。fullStream 能拿到
    // error part 并显式抛出。不要求一定有文本——GLM-4.6V 等推理模型会先吐 reasoning_content,
    // maxTokens 很小时正文可能为空,但"请求成功往返、无 error"即视为连通。
    for await (const part of result.fullStream) {
      if (part.type === "error") {
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
