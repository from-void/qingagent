import { useCallback, useEffect, useState } from "react";
import type {
  MemorySettingsResponse,
  UpdateMemorySettingsRequest,
} from "@qingagent/contract-ts";
import { useToast } from "../../system/ToastProvider";

const DEFAULT_MAX_CHARS = 6_000;

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === "string" && body.error.trim() ? body.error : fallback;
  } catch {
    return fallback;
  }
}

export function MemoryPanel() {
  const toast = useToast();
  const [content, setContent] = useState("");
  const [baseContent, setBaseContent] = useState("");
  const [exists, setExists] = useState(false);
  const [maxChars, setMaxChars] = useState(DEFAULT_MAX_CHARS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/v1/settings/memory", { signal });
    if (!response.ok) throw new Error("load_failed");
    const body = await response.json() as MemorySettingsResponse;
    if (signal?.aborted) return;
    const nextContent = typeof body.content === "string" ? body.content : "";
    setContent(nextContent);
    setBaseContent(nextContent);
    setExists(body.exists === true);
    setMaxChars(Number.isFinite(body.maxChars) && body.maxChars > 0
      ? body.maxChars
      : DEFAULT_MAX_CHARS);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal)
      .catch(() => {
        if (!controller.signal.aborted) {
          toast.show({ message: "记忆加载失败，请稍后再试", tone: "error" });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load, toast]);

  const save = async () => {
    if (content.length > maxChars) {
      toast.show({
        message: `长期记忆不能超过 ${maxChars} 字，请删减后再保存`,
        tone: "error",
      });
      return;
    }

    setSaving(true);
    try {
      const request: UpdateMemorySettingsRequest = { content, baseContent };
      const response = await fetch("/api/v1/settings/memory", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (response.status === 409) {
        toast.show({ message: "记忆已被更新，请刷新后再改", tone: "error" });
        return;
      }
      if (!response.ok) {
        toast.show({
          message: await readErrorMessage(response, "记忆保存失败，请稍后再试"),
          tone: "error",
        });
        return;
      }
      const body = await response.json() as MemorySettingsResponse;
      const savedContent = typeof body.content === "string" ? body.content : content;
      setContent(savedContent);
      setBaseContent(savedContent);
      setExists(body.exists === true);
      setMaxChars(Number.isFinite(body.maxChars) && body.maxChars > 0
        ? body.maxChars
        : maxChars);
      toast.show({ message: "记忆已保存", tone: "success" });
    } catch {
      toast.show({ message: "记忆保存失败，请稍后再试", tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-memory" data-wf="MemoryPanel">
      <h2 className="sm-title">长期记忆</h2>
      <p className="memory-description">
        这里保存跨会话复用的偏好与背景。修改将从下一个会话开始生效。
      </p>
      {!loading && !exists && content.length === 0 ? (
        <p className="memory-empty">还没有记忆，可以在下方直接添加。</p>
      ) : null}
      <textarea
        className="memory-editor"
        aria-label="长期记忆原文"
        value={content}
        disabled={loading || saving}
        placeholder={loading ? "正在加载…" : "# 用户长期记忆"}
        onChange={(event) => setContent(event.target.value)}
      />
      <div className="memory-footer">
        <span
          className="memory-count"
          data-over-limit={content.length > maxChars ? "true" : "false"}
        >
          {content.length} / {maxChars}
        </span>
        <button
          type="button"
          className="sm-btn primary"
          disabled={loading || saving || content === baseContent}
          onClick={() => void save()}
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
}
