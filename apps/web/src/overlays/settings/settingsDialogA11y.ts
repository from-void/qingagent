const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

let observer: MutationObserver | null = null;
let activeSheet: HTMLElement | null = null;
let restoreTarget: HTMLElement | null = null;
let activeCleanup: (() => void) | null = null;

export function ensureSettingsDialogA11y(): void {
  if (typeof window === "undefined" || typeof document === "undefined" || observer) return;
  const scan = () => {
    const sheet = document.querySelector<HTMLElement>(".qj-sheet[role='dialog']");
    if (sheet && activeSheet !== sheet) {
      activateSheet(sheet);
      return;
    }
    if (activeSheet && !document.body.contains(activeSheet)) {
      deactivateSheet(true);
    }
  };
  observer = new MutationObserver(scan);
  observer.observe(document.body, { childList: true, subtree: true });
  window.setTimeout(scan, 0);
}

export function resetSettingsDialogA11yForTest(): void {
  observer?.disconnect();
  observer = null;
  deactivateSheet(false);
}

function activateSheet(sheet: HTMLElement): void {
  deactivateSheet(false);
  activeSheet = sheet;
  const current = document.activeElement;
  restoreTarget = current instanceof HTMLElement && !sheet.contains(current) ? current : null;
  if (!sheet.hasAttribute("tabindex")) sheet.setAttribute("tabindex", "-1");

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const currentSheet = activeSheet;
    if (!currentSheet) return;
    const focusable = getFocusableElements(currentSheet);
    if (focusable.length === 0) {
      event.preventDefault();
      currentSheet.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !currentSheet.contains(active)) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (active === last || !currentSheet.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  sheet.addEventListener("keydown", onKeyDown, true);
  activeCleanup = () => sheet.removeEventListener("keydown", onKeyDown, true);

  requestFrame(() => {
    if (!document.body.contains(sheet) || sheet.contains(document.activeElement)) return;
    const target =
      sheet.querySelector<HTMLElement>(".qj-sheet-close") ??
      sheet.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
      getFocusableElements(sheet)[0] ??
      sheet;
    target.focus();
  });
}

function deactivateSheet(restoreFocus: boolean): void {
  activeCleanup?.();
  activeCleanup = null;
  const target = restoreTarget;
  activeSheet = null;
  restoreTarget = null;
  if (restoreFocus && target && document.body.contains(target)) {
    requestFrame(() => target.focus());
  }
}

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.closest("[inert]")) return false;
    if (element.getAttribute("aria-hidden") === "true") return false;
    return element.tabIndex >= 0;
  });
}

function requestFrame(callback: () => void): void {
  window.setTimeout(callback, 0);
}
