import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { Transaction } from "@tiptap/pm/state";
import {
  FIND_MATCH_LIMIT,
  collectMatches,
  formatFindCount,
  planReplaceAll,
  stepCursor,
  type FindBarMode,
  type FindMatch,
} from "../data/docFindModel";
import {
  clearFindDecorations,
  collectDocFindSegments,
  scrollFindMatchIntoView,
  setFindDecorations,
} from "../data/docFindPm";

interface DocFindBarProps {
  editor: Editor | null;
  mode: FindBarMode;
  docVersion: number;
  initialQuery?: string;
  scrollContainerSelector?: string;
  badgeText?: string;
  onClose: () => void;
  onToast: (msg: string) => void;
}

type RecomputeOptions = {
  resetCursor?: boolean;
  scroll?: boolean;
  preferredFrom?: number | null;
};

function nearestMatchIndex(matches: readonly FindMatch[], from: number | null): number {
  if (matches.length === 0) return -1;
  if (from === null) return 0;
  let bestIndex = 0;
  let bestDistance = Math.abs(matches[0]!.from - from);
  for (let i = 1; i < matches.length; i += 1) {
    const distance = Math.abs(matches[i]!.from - from);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

export function DocFindBar({
  editor,
  mode,
  docVersion,
  initialQuery = "",
  scrollContainerSelector = "#view-workspace .ws-right",
  badgeText,
  onClose,
  onToast,
}: DocFindBarProps) {
  const [query, setQuery] = useState(initialQuery);
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [matches, setMatches] = useState<FindMatch[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [inputComposing, setInputComposing] = useState(false);

  const findInputRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef(initialQuery);
  const replacementRef = useRef("");
  const caseSensitiveRef = useRef(false);
  const matchesRef = useRef<FindMatch[]>([]);
  const currentIndexRef = useRef(-1);
  const currentFromRef = useRef<number | null>(null);
  const inputComposingRef = useRef(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getScrollContainer = useCallback(
    () => document.querySelector<HTMLElement>(scrollContainerSelector),
    [scrollContainerSelector],
  );

  const runSearch = useCallback(
    (options: RecomputeOptions = {}) => {
      if (searchTimerRef.current !== null) {
        clearTimeout(searchTimerRef.current);
        searchTimerRef.current = null;
      }

      const currentQuery = queryRef.current;
      if (!editor || editor.isDestroyed || currentQuery === "") {
        matchesRef.current = [];
        currentIndexRef.current = -1;
        currentFromRef.current = null;
        setMatches([]);
        setTotal(0);
        setTruncated(false);
        setCurrentIndex(-1);
        clearFindDecorations(editor);
        return;
      }

      const result = collectMatches(
        collectDocFindSegments(editor.state.doc),
        currentQuery,
        caseSensitiveRef.current,
        FIND_MATCH_LIMIT,
      );
      const preferredFrom =
        options.preferredFrom !== undefined
          ? options.preferredFrom
          : options.resetCursor
            ? null
            : currentFromRef.current;
      const nextIndex =
        result.matches.length === 0
          ? -1
          : options.resetCursor
            ? 0
            : nearestMatchIndex(result.matches, preferredFrom);

      matchesRef.current = result.matches;
      currentIndexRef.current = nextIndex;
      currentFromRef.current = result.matches[nextIndex]?.from ?? null;
      setMatches(result.matches);
      setTotal(result.total);
      setTruncated(result.truncated);
      setCurrentIndex(nextIndex);
      setFindDecorations(editor, result.matches, nextIndex);

      const nextMatch = result.matches[nextIndex];
      if (options.scroll && nextMatch) {
        scrollFindMatchIntoView(editor, nextMatch.from, getScrollContainer());
      }
    },
    [editor, getScrollContainer],
  );

  const scheduleSearch = useCallback(
    (options: RecomputeOptions = {}) => {
      if (searchTimerRef.current !== null) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(() => runSearch(options), 150);
    },
    [runSearch],
  );

  useLayoutEffect(() => {
    const input = findInputRef.current;
    if (!input) return;
    input.focus();
    if (initialQuery) input.select();
  }, [initialQuery]);

  useEffect(() => {
    queryRef.current = initialQuery;
    setQuery(initialQuery);
    scheduleSearch({ resetCursor: true, scroll: initialQuery !== "" });
  }, [initialQuery, scheduleSearch]);

  useEffect(() => {
    scheduleSearch({ resetCursor: false, scroll: false });
  }, [docVersion, scheduleSearch]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      runSearch({ resetCursor: false, scroll: false });
      return;
    }
    const onUpdate = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged) {
        scheduleSearch({ resetCursor: false, scroll: false });
      }
    };
    editor.on("update", onUpdate);
    runSearch({ resetCursor: false, scroll: false });
    return () => {
      editor.off("update", onUpdate);
    };
  }, [editor, runSearch, scheduleSearch]);

  useEffect(() => {
    if (mode !== "full") setReplaceOpen(false);
  }, [mode]);

  useEffect(() => {
    return () => {
      if (searchTimerRef.current !== null) clearTimeout(searchTimerRef.current);
      clearFindDecorations(editor);
    };
  }, [editor]);

  const moveCursor = useCallback(
    (dir: 1 | -1) => {
      const nextIndex = stepCursor(currentIndexRef.current, matchesRef.current.length, dir);
      currentIndexRef.current = nextIndex;
      currentFromRef.current = matchesRef.current[nextIndex]?.from ?? null;
      setCurrentIndex(nextIndex);
      setFindDecorations(editor, matchesRef.current, nextIndex);
      const match = matchesRef.current[nextIndex];
      if (match) scrollFindMatchIntoView(editor, match.from, getScrollContainer());
    },
    [editor, getScrollContainer],
  );

  const composing = inputComposing || inputComposingRef.current || !!editor?.view.composing;
  const canReplace = mode === "full" && !composing;
  const replaceDisabledTitle =
    mode === "full"
      ? "替换"
      : badgeText?.startsWith("审阅中")
        ? "审阅中不可替换,先处理完修改建议"
        : "生成中不可替换";

  const handleClose = useCallback(() => {
    clearFindDecorations(editor);
    onClose();
    requestAnimationFrame(() => {
      if (!editor || editor.isDestroyed) return;
      editor.commands.focus();
    });
  }, [editor, onClose]);

  const handleReplaceOne = useCallback(() => {
    if (!canReplace || !editor || editor.isDestroyed) return;
    const currentMatches = matchesRef.current;
    if (currentMatches.length === 0) return;
    if (currentIndexRef.current < 0) {
      moveCursor(1);
      return;
    }

    const index = currentIndexRef.current;
    const match = currentMatches[index];
    if (!match) return;
    const nextOldMatch = currentMatches[stepCursor(index, currentMatches.length, 1)];
    let preferredFrom = match.from;
    editor.commands.command(({ tr }) => {
      tr.insertText(replacementRef.current, match.from, match.to);
      preferredFrom = nextOldMatch ? tr.mapping.map(nextOldMatch.from) : tr.mapping.map(match.from);
      return true;
    });
    runSearch({ resetCursor: false, scroll: true, preferredFrom });
  }, [canReplace, editor, moveCursor, runSearch]);

  const handleReplaceAll = useCallback(() => {
    if (!canReplace || !editor || editor.isDestroyed) return;
    const currentMatches = matchesRef.current;
    if (currentMatches.length === 0) return;
    const plans = planReplaceAll(currentMatches, replacementRef.current);
    editor.commands.command(({ tr }) => {
      for (const plan of plans) {
        tr.insertText(plan.insert, plan.from, plan.to);
      }
      return true;
    });
    onToast(`已替换 ${plans.length} 处`);
    runSearch({ resetCursor: true, scroll: false });
  }, [canReplace, editor, onToast, runSearch]);

  const countText = formatFindCount(currentIndex, total, truncated, FIND_MATCH_LIMIT);
  const noHit = query !== "" && total === 0;

  return (
    <div
      className="ws-find-bar"
      data-wf="DocFindBar"
      onKeyDown={(event) => {
        // IME 组合中(拼音选词):Enter/Esc 交给输入法确认/取消,绝不当作跳转/关闭抢走。
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          handleClose();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          moveCursor(event.shiftKey ? -1 : 1);
        }
      }}
    >
      <div className="ws-find-row">
        <input
          ref={findInputRef}
          className={`ws-find-input${noHit ? " is-nohit" : ""}`}
          placeholder="在文档中查找"
          aria-label="查找"
          value={query}
          onChange={(event) => {
            const next = event.currentTarget.value;
            queryRef.current = next;
            setQuery(next);
            scheduleSearch({ resetCursor: true, scroll: next !== "" });
          }}
          onCompositionStart={() => {
            inputComposingRef.current = true;
            setInputComposing(true);
          }}
          onCompositionEnd={() => {
            inputComposingRef.current = false;
            setInputComposing(false);
          }}
        />
        <span className="ws-find-count">{countText}</span>
        <button
          type="button"
          className="ws-find-btn"
          title="区分大小写"
          aria-pressed={caseSensitive}
          onClick={() => {
            const next = !caseSensitiveRef.current;
            caseSensitiveRef.current = next;
            setCaseSensitive(next);
            runSearch({ resetCursor: false, scroll: false });
          }}
        >
          Aa
        </button>
        <span className="ws-find-sep"></span>
        <button
          type="button"
          className="ws-find-btn"
          title="上一个 (Shift+Enter)"
          onClick={() => moveCursor(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="ws-find-btn"
          title="下一个 (Enter)"
          onClick={() => moveCursor(1)}
        >
          ↓
        </button>
        <span className="ws-find-sep"></span>
        <button
          type="button"
          className="ws-find-btn"
          title={replaceDisabledTitle}
          aria-pressed={replaceOpen}
          disabled={mode !== "full"}
          onClick={() => {
            if (mode !== "full") return;
            setReplaceOpen((value) => !value);
          }}
        >
          ⇄
        </button>
        <span className="ws-find-mode-badge" hidden={mode !== "find-only" || !badgeText}>
          {badgeText}
        </span>
        <button
          type="button"
          className="ws-find-btn"
          title="关闭 (Esc)"
          onClick={handleClose}
        >
          ✕
        </button>
      </div>
      <div className="ws-find-row ws-find-replace-row" hidden={mode !== "full" || !replaceOpen}>
        <input
          className="ws-find-input"
          placeholder="替换为"
          aria-label="替换为"
          value={replacement}
          onChange={(event) => {
            replacementRef.current = event.currentTarget.value;
            setReplacement(event.currentTarget.value);
          }}
          onCompositionStart={() => {
            inputComposingRef.current = true;
            setInputComposing(true);
          }}
          onCompositionEnd={() => {
            inputComposingRef.current = false;
            setInputComposing(false);
          }}
        />
        <button
          type="button"
          className="ws-find-act"
          disabled={!canReplace}
          onClick={handleReplaceOne}
        >
          替换
        </button>
        <button
          type="button"
          className="ws-find-act"
          disabled={!canReplace}
          onClick={handleReplaceAll}
        >
          全部替换
        </button>
      </div>
    </div>
  );
}
