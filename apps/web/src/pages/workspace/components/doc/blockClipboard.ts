export async function writeBlockClipboardPayload(html: string, plain: string) {
  let firstError: unknown = null;

  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]);
      return;
    } catch (error) {
      firstError = error;
    }
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(plain);
      return;
    } catch (error) {
      firstError ??= error;
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = plain;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    if (!document.execCommand("copy")) {
      throw firstError instanceof Error ? firstError : new Error("clipboard copy failed");
    }
  } finally {
    textarea.remove();
  }
}
