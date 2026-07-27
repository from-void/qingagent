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

export const PENDING_SUBMISSION_ID_STORAGE_KEY =
  "qingagent:pending-submission-id";

interface PendingFilesSubmission {
  submissionId: string;
  files: File[];
}

let pendingFilesSubmission: PendingFilesSubmission | null = null;

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

export function setPendingFiles(submissionId: string, files: File[]): void {
  pendingFilesSubmission = { submissionId, files };
}

export function peekPendingFiles(submissionId: string | null): File[] {
  return pendingFilesSubmission?.submissionId === submissionId
    ? pendingFilesSubmission.files
    : [];
}

export function clearPendingFiles(submissionId?: string): void {
  if (
    submissionId !== undefined &&
    pendingFilesSubmission?.submissionId !== submissionId
  ) {
    return;
  }
  pendingFilesSubmission = null;
}

export function consumePendingFiles(submissionId: string): File[] {
  const files = peekPendingFiles(submissionId);
  clearPendingFiles(submissionId);
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
