import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConfirmDecision,
  ConfirmRequested,
  ConfirmSpec,
  SubmitConfirmDecision,
} from "@qingagent/contract-ts";
import type {
  ConfirmRecord,
} from "../components/ConfirmOverlay";
import type { ServerStream } from "../data/serverStream";
import { useToast } from "../../../system";
import { publishRememberGrantState } from "../../../system/confirmGrantState";

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
      commandPreview: "npx skills add ffmpeg",
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
): Omit<ConfirmDecision, "secretValue" | "uiGrantNonce"> {
  const {
    secretValue: _secretValue,
    uiGrantNonce: _uiGrantNonce,
    ...safeDecision
  } = decision;
  return safeDecision;
}

export function useConfirmCard({
  debugMode,
  blocked = false,
  sessionId,
  stream,
}: {
  debugMode: boolean;
  blocked?: boolean;
  sessionId?: string | null;
  stream?: ServerStream | null;
}) {
  const toast = useToast();
  const [demoConfirm, setDemoConfirm] = useState<ConfirmSpec | null>(null);
  const [pendingConfirms, setPendingConfirms] = useState<ConfirmRequested[]>([]);
  const [confirmRecord, setConfirmRecord] = useState<ConfirmRecord | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const nextDemoIndexRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  const submittingRef = useRef(new Set<string>());

  useEffect(() => {
    if (sessionIdRef.current === sessionId) return;
    sessionIdRef.current = sessionId;
    setDemoConfirm(null);
    setPendingConfirms([]);
    setConfirmRecord(null);
    setDecisionError(null);
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
      setDemoConfirm(demo.spec);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [blocked, debugMode]);

  useEffect(() => {
    if (!stream) return;
    return stream.subscribe((frame) => {
      if (frame.kind === "restoreReset") {
        setPendingConfirms([]);
        setDecisionError(null);
        return;
      }
      if (frame.kind === "confirmRequested") {
        setDecisionError(null);
        setPendingConfirms((current) => {
          const withoutSame = current.filter(
            (item) => item.toolCallId !== frame.data.toolCallId,
          );
          return [...withoutSame, frame.data].sort(
            (a, b) =>
              a.requestedAt.localeCompare(b.requestedAt) ||
              a.toolCallId.localeCompare(b.toolCallId),
          );
        });
        return;
      }
      if (frame.kind === "confirmResolved") {
        submittingRef.current.delete(frame.data.id);
        setDecisionError(null);
        setPendingConfirms((current) => current.filter(
          (item) =>
            item.spec.id !== frame.data.id &&
            item.toolCallId !== frame.data.toolCallId,
        ));
        if (frame.data.message) {
          toast.show({
            message: frame.data.message,
            tone: frame.data.resolution === "accepted" ? "info" : "warn",
            // 同一张卡先 accepted、后带真实原因收口是正常序列：dedupe 必须带上
            // resolution，否则后到的真话会被前一条 toast 吞掉。
            dedupeKey: `confirm-resolved:${frame.data.id}:${frame.data.resolution}`,
            // 过期/中止/失败都不是终点：一律给一条能立刻往下走的路,
            // 不让用户对着一句笼统结论发呆。
            ...(frame.data.resolution === "expired" ||
              frame.data.resolution === "aborted" ||
              frame.data.resolution === "failed"
              ? {
                  action: {
                    label: "重新确认",
                    onClick: () => {
                      document.querySelector<HTMLElement>(".wf-input")?.focus();
                    },
                  },
                }
              : {}),
          });
        }
      }
    });
  }, [stream, toast]);

  const liveConfirm = pendingConfirms[0] ?? null;
  const inlineConfirm = liveConfirm?.spec ?? demoConfirm;
  const activeBindingRef = useRef({
    sessionId,
    confirmId: liveConfirm?.spec.id ?? null,
    generation: 0,
  });
  if (
    activeBindingRef.current.sessionId !== sessionId ||
    activeBindingRef.current.confirmId !== (liveConfirm?.spec.id ?? null)
  ) {
    activeBindingRef.current = {
      sessionId,
      confirmId: liveConfirm?.spec.id ?? null,
      generation: activeBindingRef.current.generation + 1,
    };
  }
  const componentGeneration = activeBindingRef.current.generation;

  const handleConfirmDecision = useCallback(async (
    decision: ConfirmDecision,
    componentContext?: { componentMounted: false },
  ) => {
    if (liveConfirm && stream && sessionId) {
      if (submittingRef.current.has(decision.id)) return;
      submittingRef.current.add(decision.id);
      setDecisionError(null);
      const submission: SubmitConfirmDecision = {
        sessionId,
        toolCallId: liveConfirm.toolCallId,
        decisionId: crypto.randomUUID(),
        decision,
      };
      const isCurrentBinding = () =>
        componentContext?.componentMounted !== false &&
        activeBindingRef.current.generation === componentGeneration &&
        activeBindingRef.current.sessionId === sessionId &&
        activeBindingRef.current.confirmId === liveConfirm.spec.id;
      void stream.resolveConfirm(submission, {
        activateSession: isCurrentBinding(),
      }).then((result) => {
        if (result.grantState && liveConfirm.spec.rememberCategory) {
          publishRememberGrantState({
            kind: liveConfirm.spec.rememberCategory.kind,
            ...result.grantState,
          });
        }
        // 勾了「以后不用再问我」:用一条普通 toast 交代清楚现在是什么形态、去哪改回。
        // 不在工作区常驻标识——常驻只会变成一个天天在的提醒条,与"少打扰"的诉求相反。
        if (result.bypassEnabled === true) {
          toast.show({
            message: "以后不再询问，命令会直接执行。可在 设置 → 安全 里改回。",
            tone: "success",
            dedupeKey: `confirm-bypass-enabled:${decision.id}`,
          });
        } else if (result.bypassEnabled === false) {
          toast.show({
            message: "本次操作会继续，但这项设置没有保存成功；下次仍会询问。",
            tone: "warn",
            dedupeKey: `confirm-bypass-not-saved:${decision.id}`,
          });
        }
        if (result.remembered) {
          const message = liveConfirm.spec.kind === "install"
            ? "已记住：以后安装时不再询问。可在 设置 → 安全 中恢复每次询问。"
            : "已记住：以后遇到同类操作不再询问。可在 设置 → 安全 中恢复每次询问。";
          toast.show({
            message,
            tone: "success",
            dedupeKey: `confirm-remembered:${decision.id}`,
          });
        } else if (result.rememberFailure) {
          toast.show({
            message: result.rememberFailure === "settings-changed"
              ? "本次操作会继续，但设置刚刚发生变化，没有记住这次选择；下次同类操作仍会询问。"
              : "本次操作会继续，但没有记住这次选择；下次同类操作仍会询问。",
            tone: "warn",
            dedupeKey: `confirm-remember-not-saved:${decision.id}`,
          });
        }
        if (!isCurrentBinding()) submittingRef.current.delete(decision.id);
      }).catch((error: unknown) => {
        submittingRef.current.delete(decision.id);
        if (isCurrentBinding()) {
          setDecisionError(
            error instanceof Error && error.message.trim()
              ? error.message
              : "确认没有提交成功，命令尚未确定是否执行。请先查看命令卡，不要连续重复点击。",
          );
        }
      });
      return;
    }

    const safeDecision = stripSecretFromDecision(decision);
    if (debugMode) console.debug("[confirm-card] decision", safeDecision);
    if (decision.accepted) {
      const demo = CONFIRM_CARD_DEMOS.find(
        (item) => item.spec.id === decision.id,
      );
      if (demo) setConfirmRecord(demo.record);
    }
    setDemoConfirm(null);
  }, [componentGeneration, debugMode, liveConfirm, sessionId, stream, toast]);

  return {
    confirmRecord,
    handleConfirmDecision,
    inlineConfirm,
    decisionError,
    isLiveConfirm: liveConfirm !== null,
  };
}
