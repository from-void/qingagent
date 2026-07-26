import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
} from "react";
import type { Editor } from "@tiptap/react";
import {
  aiIrToPm,
  normalizePmDoc,
  pmToLegacySections,
  type PmDoc,
} from "@qingagent/pm-schema";
import type { Command, LegacySection } from "@qingagent/contract-ts";
import { validateCommand } from "../../../system/validators";
import type { DocumentSnapshotViewHandle } from "../components/DocumentSnapshotView";
import type { StarterBlankTarget } from "../components/StarterPanel";
import {
  buildTemplateSkeleton,
  type StarterTemplate,
} from "../data/starterTemplates";
import {
  classifyDocSaveError,
  TRANSIENT_DOC_SAVE_TOAST,
} from "../data/docSaveError";
import {
  PendingDocSaveError,
  docSaveFailureToastMessage,
  type PendingDocSaveWaiter,
} from "../data/pendingDocSave";
import {
  createClientMutationId,
  flushDocSaveOnPageExit,
  pageExitDocSaveFingerprint,
  pmDocHasSubstantiveContent,
  shouldFlushDocSaveOnPageExit,
} from "../data/pageExitSave";
import {
  ensureSessionIdOnce,
  replaceWorkspaceSessionHash,
} from "../data/sessionLifecycle";
import { canEditDocument } from "../data/workspacePageView";
import { deriveDocDimensions } from "../data/docDimensions";
import {
  isAbnormalDocumentCollapse,
  measureDocumentShape,
} from "../data/documentIntegrity";
import type { NativePresentationRun } from "../data/nativeDiffAnimation";
import type { ServerStream } from "../data/serverStream";
import type { WorkspaceAction, WorkspaceState } from "../data/workspaceState";
import type { DocWriteBaseline } from "../data/docWriteBaseline";

export interface DocWriteTarget {
  sessionId: string;
  stream: ServerStream;
  streamGeneration: number;
}

export interface QueuedDocWrite extends DocWriteTarget {
  pmDoc: PmDoc;
  baseline: DocWriteBaseline;
}

export type SendDocWrite = (
  pmDoc: PmDoc,
  target?: DocWriteTarget,
  baseline?: DocWriteBaseline,
) => Promise<void>;

function buildBlankStarterDoc(): PmDoc {
  return aiIrToPm({
    title: null,
    blocks: [{ type: "paragraph", runs: [] }],
  });
}

function focusStarterBlankTarget(
  editor: Editor,
  target: StarterBlankTarget,
): boolean {
  if (editor.isDestroyed) return false;
  const targetNode = (
    { body: "paragraph" } satisfies Record<StarterBlankTarget, "paragraph">
  )[target];
  let focusPos: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== targetNode) return true;
    focusPos = pos + 1;
    return false;
  });
  if (focusPos === null) return false;
  const maxPos = Math.max(1, editor.state.doc.content.size);
  editor.chain().focus(Math.min(focusPos, maxPos)).run();
  return true;
}

export function useWorkspaceDocumentEditor(input: {
  tiptapEditor: Editor | null;
  tiptapEditorRef: MutableRefObject<Editor | null>;
  state: WorkspaceState;
  stateRef: MutableRefObject<WorkspaceState>;
  streamRef: MutableRefObject<ServerStream | null>;
  streamGenerationRef: MutableRefObject<number>;
  sessionIdRef: MutableRefObject<string | null>;
  startNewSessionPromiseRef: MutableRefObject<Promise<string> | null>;
  docVersionRef: MutableRefObject<number>;
  baseContentHashRef: MutableRefObject<string>;
  pendingDocWriteRef: MutableRefObject<boolean>;
  queuedPmDocRef: MutableRefObject<QueuedDocWrite | null>;
  scheduledDocWriteRef: MutableRefObject<boolean>;
  latestDocMutationIdRef: MutableRefObject<string | null>;
  lastSentPmDocRef: MutableRefObject<PmDoc | null>;
  lastSentDocWriteBaselineRef: MutableRefObject<DocWriteBaseline | null>;
  docWriteAckRef: MutableRefObject<Map<string, PendingDocSaveWaiter>>;
  docSaveRetryTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  sendDocWriteRef: MutableRefObject<SendDocWrite>;
  pendingBlankFocusRef: MutableRefObject<StarterBlankTarget | null>;
  fillTemplatePromiseRef: MutableRefObject<Promise<void> | null>;
  presentationRunRef: MutableRefObject<NativePresentationRun | null>;
  docViewRef: MutableRefObject<DocumentSnapshotViewHandle | null>;
  pageExitDocSaveFingerprintRef: MutableRefObject<string | null>;
  foregroundDocSaveDepthRef: MutableRefObject<number>;
  dispatch: Dispatch<WorkspaceAction>;
  showToast: (message: string, durationMs?: number) => void;
  showBackgroundDocSaveFailure: (error: unknown) => void;
  rejectPendingDocSaveDrain: (error: Error) => void;
  waitForPendingDocSaveDrain: () => Promise<void>;
}) {
  const {
    tiptapEditor,
    tiptapEditorRef,
    state,
    stateRef,
    streamRef,
    streamGenerationRef,
    sessionIdRef,
    startNewSessionPromiseRef,
    docVersionRef,
    baseContentHashRef,
    pendingDocWriteRef,
    queuedPmDocRef,
    scheduledDocWriteRef,
    latestDocMutationIdRef,
    lastSentPmDocRef,
    lastSentDocWriteBaselineRef,
    docWriteAckRef,
    docSaveRetryTimerRef,
    sendDocWriteRef,
    pendingBlankFocusRef,
    fillTemplatePromiseRef,
    presentationRunRef,
    docViewRef,
    pageExitDocSaveFingerprintRef,
    foregroundDocSaveDepthRef,
    dispatch,
    showToast,
    showBackgroundDocSaveFailure,
    rejectPendingDocSaveDrain,
    waitForPendingDocSaveDrain,
  } = input;

  const failedTransientDocWriteRef = useRef<QueuedDocWrite | null>(null);

  const sendDocWrite = useCallback(
    (
      pmDoc: PmDoc,
      explicitTarget?: DocWriteTarget,
      explicitBaseline?: DocWriteBaseline,
    ): Promise<void> => {
      const stream = explicitTarget?.stream ?? streamRef.current;
      const sessionId = explicitTarget?.sessionId ?? sessionIdRef.current;
      const streamGeneration =
        explicitTarget?.streamGeneration ?? streamGenerationRef.current;
      if (!stream || !sessionId) {
        const error = new PendingDocSaveError(
          "连接未就绪，刚才的手动编辑未保存。",
        );
        showBackgroundDocSaveFailure(error);
        rejectPendingDocSaveDrain(error);
        return Promise.reject(error);
      }

      const legacySections = pmToLegacySections(
        pmDoc,
      ) as unknown as LegacySection[];
      const clientMutationId = createClientMutationId();
      const baseline = explicitBaseline ?? {
        expectedDocumentSnapshot: docVersionRef.current,
        baseContentHash: baseContentHashRef.current,
        baseHasSubstantiveContent: Boolean(
          stateRef.current.doc?.pmDoc &&
          pmDocHasSubstantiveContent(stateRef.current.doc.pmDoc),
        ),
      };
      const {
        expectedDocumentSnapshot,
        baseContentHash,
      } = baseline;
      const command: Command = {
        kind: "updateDoc",
        data: {
          sessionId,
          expectedDocumentSnapshot,
          baseContentHash,
          doc: pmDoc,
          legacySections,
          clientMutationId,
        },
      };

      try {
        validateCommand(command);
      } catch (e) {
        console.error("[workspace] updateDoc validation failed", e);
        const error = new PendingDocSaveError(
          "保存失败，请检查文档内容后重试。",
        );
        showBackgroundDocSaveFailure(error);
        rejectPendingDocSaveDrain(error);
        return Promise.reject(error);
      }

      pendingDocWriteRef.current = true;
      latestDocMutationIdRef.current = clientMutationId;
      lastSentPmDocRef.current = pmDoc;
      lastSentDocWriteBaselineRef.current = baseline;
      // 新编辑或 online 重发一旦开始，以本次发送为最新待落库内容，淘汰旧失败快照。
      failedTransientDocWriteRef.current = null;

      const ackPromise = new Promise<void>((resolve, reject) => {
        docWriteAckRef.current.set(clientMutationId, { resolve, reject });
      });

      const failAck = (error: Error) => {
        const waiter = docWriteAckRef.current.get(clientMutationId);
        docWriteAckRef.current.delete(clientMutationId);
        if (latestDocMutationIdRef.current === clientMutationId) {
          pendingDocWriteRef.current = false;
          latestDocMutationIdRef.current = null;
          queuedPmDocRef.current = null;
          scheduledDocWriteRef.current = false;
        }
        waiter?.reject(error);
        rejectPendingDocSaveDrain(error);
      };

      // 保存路径已是单飞 + 队列(同一时刻仅一条 updateDoc 在途)。瞬态网络失败
      // (Failed to fetch / 请求被取消)请求多半没到服务端,用同一 expectedDocumentSnapshot
      // 静默重试是安全的;重试期间保持单飞占用,不弹刺眼错误。内容始终在编辑器里(下次编辑/
      // 离开页面都会兜底重存),所以瞬态最终失败也只给温和文案,不吓用户。
      const MAX_TRANSIENT_DOC_SAVE_RETRIES = 2;
      const canRetryDocSave = () =>
        sessionIdRef.current === sessionId &&
        streamRef.current === stream &&
        streamGenerationRef.current === streamGeneration &&
        latestDocMutationIdRef.current === clientMutationId &&
        docWriteAckRef.current.has(clientMutationId);

      const attemptDocSaveSend = (attempt: number): void => {
        stream
          .sendCommand(command)
          .then(() => {
            // SSE 结束但 ack 未到(请求被取消/服务端未回 docWriteResult):内容仍在编辑器,
            // 不当硬失败弹红错;静默收尾,靠下次编辑或离开页面兜底重存。
            if (!docWriteAckRef.current.has(clientMutationId)) return;
            failAck(
              new PendingDocSaveError(
                "保存未收到服务端确认,下次编辑会自动重存。",
              ),
            );
          })
          .catch((e) => {
            const isTransient = classifyDocSaveError(e) === "transient";
            if (
              isTransient &&
              attempt < MAX_TRANSIENT_DOC_SAVE_RETRIES &&
              canRetryDocSave()
            ) {
              console.warn(
                `[workspace] updateDoc 瞬态失败,自动重试 ${attempt + 1}/${MAX_TRANSIENT_DOC_SAVE_RETRIES}`,
                e,
              );
              docSaveRetryTimerRef.current = setTimeout(
                () => {
                  docSaveRetryTimerRef.current = null;
                  // fire 时再判一次:退避窗口内若切了会话 / 被取代 / 已卸载,绝不用旧态重发。
                  if (!canRetryDocSave()) return;
                  attemptDocSaveSend(attempt + 1);
                },
                300 * (attempt + 1),
              );
              return;
            }
            const error = isTransient
              ? new PendingDocSaveError(TRANSIENT_DOC_SAVE_TOAST)
              : e instanceof Error
                ? new PendingDocSaveError(`保存请求失败：${e.message}`)
                : new PendingDocSaveError("保存请求失败，请重试。");
            if (isTransient && canRetryDocSave()) {
              const queued = queuedPmDocRef.current;
              failedTransientDocWriteRef.current =
                queued &&
                queued.sessionId === sessionId &&
                queued.stream === stream &&
                queued.streamGeneration === streamGeneration
                  ? queued
                  : { pmDoc, sessionId, stream, streamGeneration, baseline };
            }
            console.error("[workspace] updateDoc failed", e);
            failAck(error);
            showBackgroundDocSaveFailure(error);
          });
      };

      attemptDocSaveSend(0);

      return ackPromise;
    },
    [rejectPendingDocSaveDrain, showBackgroundDocSaveFailure],
  );

  useEffect(() => {
    sendDocWriteRef.current = sendDocWrite;
  }, [sendDocWrite]);

  useEffect(() => {
    const retryFailedDocWrite = () => {
      const failed = failedTransientDocWriteRef.current;
      if (!failed) return;
      if (
        sessionIdRef.current !== failed.sessionId ||
        streamRef.current !== failed.stream ||
        streamGenerationRef.current !== failed.streamGeneration
      ) {
        failedTransientDocWriteRef.current = null;
        return;
      }
      if (pendingDocWriteRef.current || scheduledDocWriteRef.current) return;
      failedTransientDocWriteRef.current = null;
      sendDocWriteRef.current(failed.pmDoc, failed, failed.baseline).catch((error) => {
        // sendDocWrite 会重新登记仍属瞬态的失败快照；这里仅避免 online 事件产生未处理拒绝。
        console.error("[workspace] online updateDoc retry failed", error);
      });
    };

    window.addEventListener("online", retryFailedDocWrite);
    return () => window.removeEventListener("online", retryFailedDocWrite);
  }, []);

  const focusPendingBlankTarget = useCallback(() => {
    const target = pendingBlankFocusRef.current;
    if (!target) return;
    window.requestAnimationFrame(() => {
      const editor = tiptapEditorRef.current;
      if (!editor || editor.isDestroyed || !editor.isEditable) return;
      if (focusStarterBlankTarget(editor, target)) {
        pendingBlankFocusRef.current = null;
      }
    });
  }, []);

  useEffect(() => {
    if (!pendingBlankFocusRef.current || !tiptapEditor) return;
    focusPendingBlankTarget();
  }, [focusPendingBlankTarget, tiptapEditor, state.docState.kind, state.doc]);

  // 空引导态点击模板「填充」:惰性创建会话 → 把骨架写入文档(走和手动编辑一致的 updateDoc 路径)。
  // 单飞(review #2):in-flight 期间重复点击直接忽略——双击会并发两条 expectedDocumentSnapshot=0
  // 的 updateDoc,第二条必撞 conflict,且把 latestDocMutationIdRef 覆盖成失败那条,造成
  // "服务端已填充成功、前端却显示失败+空文档"的三重误导。promise 存 ref,发送消息前可等它落定(review #6)。
  const handleFillTemplate = useCallback(
    (template: StarterTemplate) => {
      const stream = streamRef.current;
      if (!stream) {
        showToast("连接未就绪 · 请稍候重试");
        return;
      }
      // 上一次填充/其它 doc 写还在途:忽略本次点击,不制造并发首写
      if (fillTemplatePromiseRef.current) return;
      if (pendingDocWriteRef.current || scheduledDocWriteRef.current) return;
      let skeleton: PmDoc;
      try {
        skeleton = buildTemplateSkeleton(template);
      } catch (e) {
        console.error("[workspace] build template skeleton failed", e);
        showToast("填充失败 · 模板异常");
        return;
      }
      // 单飞守卫保证 in-flight 期间不会有第二次填充覆盖 ref,finally 直接置空即可
      fillTemplatePromiseRef.current = (async () => {
        try {
          await ensureSessionIdOnce(
            stream,
            stateRef,
            sessionIdRef,
            startNewSessionPromiseRef,
            replaceWorkspaceSessionHash,
          );
          await sendDocWriteRef.current(skeleton);
        } catch (e) {
          console.error("[workspace] fill template failed", e);
          showToast("填充失败 · 请重试");
        } finally {
          fillTemplatePromiseRef.current = null;
        }
      })();
    },
    [showToast],
  );

  const handleCreateBlankDoc = useCallback(
    (target: StarterBlankTarget) => {
      let blankDoc: PmDoc;
      try {
        blankDoc = buildBlankStarterDoc();
      } catch (e) {
        console.error("[workspace] build blank starter doc failed", e);
        showToast("创建失败 · 空文档异常");
        return;
      }
      pendingBlankFocusRef.current = target;
      dispatch({
        kind: "manualDocSaved",
        pmDoc: blankDoc,
        version: stateRef.current.version,
      });
      focusPendingBlankTarget();
    },
    [focusPendingBlankTarget, showToast],
  );

  const handleEditorChange = useCallback(
    (pmDoc: PmDoc, explicitBaseline?: DocWriteBaseline): Promise<void> => {
      const current = stateRef.current;
      if (
        !canEditDocument(
          deriveDocDimensions(current),
          current.viewingVersion,
        ) ||
        presentationRunRef.current !== null ||
        !current.doc
      ) {
        return Promise.resolve();
      }

      const persistedBaseline = current.doc.pmDoc ?? null;
      if (isAbnormalDocumentCollapse(persistedBaseline, pmDoc)) {
        console.error("[workspace] 拒绝保存异常坍缩文档", {
          previous: persistedBaseline
            ? measureDocumentShape(persistedBaseline)
            : null,
          rejected: measureDocumentShape(pmDoc),
        });
        showToast("检测到文档结构异常，本次损坏内容未保存");
        return Promise.resolve();
      }

      // 廉价判断在前(review E2):有 session 的常规编辑(绝大多数)直接短路,不白跑整树遍历
      if (!current.sessionId && !pmDocHasSubstantiveContent(pmDoc)) {
        dispatch({
          kind: "manualDocSaved",
          pmDoc,
          version: current.version,
        });
        return Promise.resolve();
      }

      const persistDoc = (): Promise<void> => {
        const stream = streamRef.current;
        const sessionId = sessionIdRef.current;
        if (!stream || !sessionId) {
          const error = new PendingDocSaveError(
            "连接未就绪，刚才的手动编辑未保存。",
          );
          showBackgroundDocSaveFailure(error);
          rejectPendingDocSaveDrain(error);
          return Promise.reject(error);
        }
        const target: DocWriteTarget = {
          sessionId,
          stream,
          streamGeneration: streamGenerationRef.current,
        };
        const baseline = explicitBaseline ?? {
          expectedDocumentSnapshot: docVersionRef.current,
          baseContentHash: baseContentHashRef.current,
          baseHasSubstantiveContent: Boolean(
            current.doc?.pmDoc &&
            pmDocHasSubstantiveContent(current.doc.pmDoc),
          ),
        };
        if (pendingDocWriteRef.current || scheduledDocWriteRef.current) {
          queuedPmDocRef.current = { pmDoc, ...target, baseline };
          return waitForPendingDocSaveDrain();
        }
        return sendDocWriteRef.current(pmDoc, target, baseline);
      };

      if (!current.sessionId) {
        const stream = streamRef.current;
        if (!stream) {
          const error = new PendingDocSaveError(
            "连接未就绪，刚才的手动编辑未保存。",
          );
          showBackgroundDocSaveFailure(error);
          rejectPendingDocSaveDrain(error);
          return Promise.reject(error);
        }
        return ensureSessionIdOnce(
          stream,
          stateRef,
          sessionIdRef,
          startNewSessionPromiseRef,
          replaceWorkspaceSessionHash,
        ).then(() => persistDoc());
      }

      if (pendingDocWriteRef.current || scheduledDocWriteRef.current) {
        return persistDoc();
      }
      return persistDoc();
    },
    [
      rejectPendingDocSaveDrain,
      showBackgroundDocSaveFailure,
      showToast,
      waitForPendingDocSaveDrain,
    ],
  );

  const flushPendingDocSave = useCallback(async () => {
    foregroundDocSaveDepthRef.current += 1;
    try {
      await docViewRef.current?.flushPendingDocSave();
      await waitForPendingDocSaveDrain();
    } finally {
      foregroundDocSaveDepthRef.current = Math.max(
        0,
        foregroundDocSaveDepthRef.current - 1,
      );
    }
  }, [waitForPendingDocSaveDrain]);

  const preparePageExitDocSave = useCallback((): (() => void) | null => {
    const editor = tiptapEditorRef.current;
    const sessionId = sessionIdRef.current;
    if (!editor || editor.isDestroyed || !sessionId) return null;
    const current = stateRef.current;
    if (
      !current.doc ||
      !canEditDocument(deriveDocDimensions(current), current.viewingVersion)
    ) {
      return null;
    }

    let pmDoc: PmDoc;
    try {
      pmDoc = normalizePmDoc(editor.getJSON());
    } catch (error) {
      console.error("[workspace] page-exit updateDoc validation failed", error);
      return null;
    }

    const expectedDocumentSnapshot = docVersionRef.current;
    const baseContentHash = baseContentHashRef.current;
    const baselineDoc = current.doc.pmDoc ?? null;
    if (isAbnormalDocumentCollapse(baselineDoc, pmDoc)) {
      console.error("[workspace] page-exit 拒绝保存异常坍缩文档", {
        previous: baselineDoc ? measureDocumentShape(baselineDoc) : null,
        rejected: measureDocumentShape(pmDoc),
      });
      return null;
    }
    const hasPendingDocSave =
      pendingDocWriteRef.current ||
      queuedPmDocRef.current !== null ||
      scheduledDocWriteRef.current;
    if (
      (expectedDocumentSnapshot === 0 && !pmDocHasSubstantiveContent(pmDoc)) ||
      !shouldFlushDocSaveOnPageExit({
        pmDoc,
        baselineDoc,
        hasPendingDocSave,
      })
    ) {
      return null;
    }

    const fingerprint = pageExitDocSaveFingerprint({
      sessionId,
      expectedDocumentSnapshot,
      baseContentHash,
      pmDoc,
    });
    return () => {
      if (pageExitDocSaveFingerprintRef.current === fingerprint) return;
      try {
        const result = flushDocSaveOnPageExit({
          sessionId,
          expectedDocumentSnapshot,
          baseContentHash,
          pmDoc,
          baselineDoc,
          hasPendingDocSave,
        });
        if (result !== "skipped") {
          pageExitDocSaveFingerprintRef.current = fingerprint;
        }
      } catch (error) {
        console.error("[workspace] page-exit updateDoc flush failed", error);
      }
    };
  }, []);

  const getLatestExportPmDoc = useCallback((): PmDoc | null => {
    const editor = tiptapEditorRef.current;
    if (editor && !editor.isDestroyed) {
      try {
        return normalizePmDoc(editor.getJSON());
      } catch (error) {
        console.error("[workspace] export live doc validation failed", error);
      }
    }
    return stateRef.current.doc?.pmDoc ?? null;
  }, []);

  useEffect(() => {
    const pageExitFlush = () => {
      preparePageExitDocSave()?.();
    };

    const visibilityFlush = () => {
      if (document.visibilityState !== "hidden") return;
      void flushPendingDocSave().catch((error) => {
        console.error("[workspace] hidden updateDoc flush failed", error);
      });
    };

    window.addEventListener("pagehide", pageExitFlush);
    window.addEventListener("beforeunload", pageExitFlush);
    document.addEventListener("visibilitychange", visibilityFlush);
    return () => {
      window.removeEventListener("pagehide", pageExitFlush);
      window.removeEventListener("beforeunload", pageExitFlush);
      document.removeEventListener("visibilitychange", visibilityFlush);
    };
  }, [flushPendingDocSave, preparePageExitDocSave]);
  return {
    flushPendingDocSave,
    getLatestExportPmDoc,
    handleCreateBlankDoc,
    handleEditorChange,
    handleFillTemplate,
    preparePageExitDocSave,
  };
}
