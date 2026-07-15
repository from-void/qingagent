import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConfirmDecision,
  ConfirmRecord,
  ConfirmSpec,
} from "../components/ConfirmOverlay";

interface ConfirmDemo {
  spec: ConfirmSpec;
  record: ConfirmRecord;
}

export const CONFIRM_CARD_DEMOS: readonly ConfirmDemo[] = [
  {
    spec: {
      id: "confirm-demo-install-ffmpeg",
      kind: "install",
      title: "安装工具",
      sub: "ffmpeg · 音视频处理",
      say: "需要安装 ffmpeg,用来把《产品发布会.mp4》转成 GIF · 官方来源 · 约 32 MB",
      footHint: "以后使用不再询问 · 可在设置里卸载",
      primaryLabel: "安装并继续",
      secondaryLabel: "先跳过",
    },
    record: {
      label: "已安装 ffmpeg",
      segment: "32 MB · 用时 41 秒",
      meta: "14:32",
    },
  },
  {
    spec: {
      id: "confirm-demo-connect-yuque",
      kind: "connect",
      title: "连接语雀",
      sub: "jimmy-zhang · 已登录",
      say: "检测到这台电脑已登录语雀(jimmy-zhang)",
      widget: {
        type: "options",
        options: [
          {
            value: "signed-in-account",
            label: "使用已登录的账号",
            description: "直接使用本机语雀登录态,无需输入任何内容",
            recommended: true,
          },
          {
            value: "access-token",
            label: "粘贴访问令牌",
            description: "从语雀「个人设置 → Token」复制粘贴",
          },
        ],
      },
      footHint: "只读 · www.yuque.com · 设置中随时断开",
      primaryLabel: "连接",
      secondaryLabel: "暂不连接",
    },
    record: {
      label: "已连接语雀",
      segment: "jimmy-zhang · 只读",
      meta: "设置中管理",
    },
  },
  {
    spec: {
      id: "confirm-demo-connect-mizhu",
      kind: "connect",
      title: "连接墨潴笔记",
      say: "粘贴墨潴笔记的访问令牌(在 App「设置 → 开发者」中获取)",
      widget: {
        type: "secretInput",
        placeholder: "粘贴访问令牌",
      },
      footHint: "只读 · api.mizhu.example.com · 令牌只发给该服务",
      primaryLabel: "连接",
      secondaryLabel: "暂不连接",
    },
    record: {
      label: "已连接墨潴笔记",
      segment: "只读",
      meta: "设置中管理",
    },
  },
  {
    spec: {
      id: "confirm-demo-send-wechat",
      kind: "send",
      title: "发布到公众号",
      sub: "深圳晚八点 · 草稿箱",
      say: "将发送到公众号「深圳晚八点」草稿箱:《Q3 产品规划:五个目标,一张表看懂》· 全文 1,832 字 · 封面 1 张",
      footHint: "不会直接群发 · 每次外发都单独确认",
      primaryLabel: "确认发布",
      secondaryLabel: "再改改",
    },
    record: {
      label: "已发布到公众号草稿箱",
      segment: "深圳晚八点",
      meta: "15:07",
    },
  },
];

export function stripSecretFromDecision(
  decision: ConfirmDecision,
): Omit<ConfirmDecision, "secretValue"> {
  const { secretValue: _secretValue, ...safeDecision } = decision;
  return safeDecision;
}

export function useConfirmCard({
  debugMode,
  blocked = false,
  sessionId,
}: {
  debugMode: boolean;
  blocked?: boolean;
  sessionId?: string | null;
}) {
  const [inlineConfirm, setInlineConfirm] = useState<ConfirmSpec | null>(null);
  const [confirmRecord, setConfirmRecord] = useState<ConfirmRecord | null>(null);
  const nextDemoIndexRef = useRef(0);
  const sessionIdRef = useRef(sessionId);

  useEffect(() => {
    if (sessionIdRef.current === sessionId) return;
    sessionIdRef.current = sessionId;
    setInlineConfirm(null);
    setConfirmRecord(null);
    nextDemoIndexRef.current = 0;
  }, [sessionId]);

  useEffect(() => {
    if (!debugMode || blocked) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        !event.ctrlKey ||
        !event.shiftKey ||
        (event.key !== "U" && event.key !== "u")
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        event.defaultPrevented ||
        target?.closest?.(".wf-doc, [contenteditable], input, textarea")
      ) {
        return;
      }
      event.preventDefault();
      const demo = CONFIRM_CARD_DEMOS[nextDemoIndexRef.current]!;
      nextDemoIndexRef.current =
        (nextDemoIndexRef.current + 1) % CONFIRM_CARD_DEMOS.length;
      setInlineConfirm(demo.spec);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [blocked, debugMode]);

  const handleConfirmDecision = useCallback((decision: ConfirmDecision) => {
    const safeDecision = stripSecretFromDecision(decision);
    console.debug("[confirm-card] decision", safeDecision);
    if (decision.accepted) {
      const demo = CONFIRM_CARD_DEMOS.find(
        (item) => item.spec.id === decision.id,
      );
      if (demo) setConfirmRecord(demo.record);
    }
    setInlineConfirm(null);
  }, []);

  return {
    confirmRecord,
    handleConfirmDecision,
    inlineConfirm,
  };
}
