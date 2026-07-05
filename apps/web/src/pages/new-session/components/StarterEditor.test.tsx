// @vitest-environment jsdom
import {
  act,
  createRef,
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StarterEditor } from "./StarterEditor";
import type { StarterEditorHandle } from "./StarterEditor";

interface PendingEntry {
  id: string;
  file: File;
}

interface AttachmentHarnessHandle {
  addFile: (id: string, file: File) => void;
  pendingFiles: () => File[];
  submit: () => void;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("StarterEditor 附件 chip 同步", () => {
  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.restoreAllMocks();
  });

  it("删除上传 chip 会同步父组件附件状态，提交只带剩余文件", async () => {
    const harnessRef = createRef<AttachmentHarnessHandle>();
    const onSubmitFiles = vi.fn();
    await render(<AttachmentHarness ref={harnessRef} onSubmitFiles={onSubmitFiles} />);
    const first = new File(["first"], "same.txt", { type: "text/plain", lastModified: 1 });
    const second = new File(["second"], "same.txt", { type: "text/plain", lastModified: 2 });

    await act(async () => {
      harnessRef.current?.addFile("att-1", first);
      harnessRef.current?.addFile("att-2", second);
    });

    expect(harnessRef.current?.pendingFiles()).toEqual([first, second]);

    const firstRemove = host?.querySelector<HTMLElement>(".src-chip .c-x");
    if (!firstRemove) throw new Error("remove button not found");
    await act(async () => {
      firstRemove.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(harnessRef.current?.pendingFiles()).toEqual([second]);

    await act(async () => {
      harnessRef.current?.submit();
    });

    expect(onSubmitFiles).toHaveBeenCalledWith([second]);
  });
});

const AttachmentHarness = forwardRef<
  AttachmentHarnessHandle,
  { onSubmitFiles: (files: File[]) => void }
>(function AttachmentHarness({ onSubmitFiles }, ref) {
  const editorRef = useRef<StarterEditorHandle>(null);
  const pendingRef = useRef<PendingEntry[]>([]);
  const [, setPending] = useState<PendingEntry[]>([]);

  const setPendingEntries = (updater: (prev: PendingEntry[]) => PendingEntry[]) => {
    const next = updater(pendingRef.current);
    pendingRef.current = next;
    setPending(next);
  };

  useImperativeHandle(
    ref,
    () => ({
      addFile(id, file) {
        setPendingEntries((prev) => [...prev, { id, file }]);
        editorRef.current?.insertChip({ id, type: "txt", name: file.name });
      },
      pendingFiles() {
        return pendingRef.current.map((entry) => entry.file);
      },
      submit() {
        onSubmitFiles(pendingRef.current.map((entry) => entry.file));
      },
    }),
    [onSubmitFiles],
  );

  return (
    <StarterEditor
      ref={editorRef}
      placeholder="输入"
      onChange={() => undefined}
      onSubmit={() => onSubmitFiles(pendingRef.current.map((entry) => entry.file))}
      onRemoveChip={(chip) => {
        if (!chip.id) return;
        setPendingEntries((prev) => prev.filter((entry) => entry.id !== chip.id));
      }}
    />
  );
});

async function render(element: ReactNode): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
  });
}
