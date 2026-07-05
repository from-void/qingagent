/**
 * Module-level state for passing pending files across SPA route transitions.
 *
 * When the user picks files on NewSessionPage we store the native File objects
 * here (no base64 encoding). WorkspacePage peeks at them on mount, uploads to
 * the server, and clears the slot only after a successful send.
 *
 * peek/clear split avoids StrictMode double-mount consuming files on first mount
 * and leaving the second mount with nothing.
 */

let pendingFiles: File[] = [];

export interface PendingDesktopFolderSource {
  provider: "desktop-local";
  selectedAt: number;
  selection: {
    selectionToken: string;
    name: string;
    pathLabel: string;
    fileCount: number | null;
    fileCountCapped: boolean;
  };
}

export interface PendingBrowserFolderSource {
  provider: "browser-fs-access";
  picked: {
    handle: FileSystemDirectoryHandle;
    name: string;
    browserHandleKey: string;
    clientSourceId: string;
  };
}

export type PendingFolderSource = PendingDesktopFolderSource | PendingBrowserFolderSource;

let pendingFolderSource: PendingFolderSource | null = null;

export function setPendingFiles(files: File[]): void {
  pendingFiles = files;
}

export function peekPendingFiles(): File[] {
  return pendingFiles;
}

export function clearPendingFiles(): void {
  pendingFiles = [];
}

export function consumePendingFiles(): File[] {
  const files = pendingFiles;
  clearPendingFiles();
  return files;
}

export function setPendingFolderSource(source: PendingFolderSource | null): void {
  pendingFolderSource = source;
}

export function peekPendingFolderSource(): PendingFolderSource | null {
  return pendingFolderSource;
}

export function clearPendingFolderSource(): void {
  pendingFolderSource = null;
}

export function consumePendingFolderSource(): PendingFolderSource | null {
  const source = pendingFolderSource;
  clearPendingFolderSource();
  return source;
}
