import type { DesktopStartupNoticeKind } from "../startupNoticeContract.js";
import { readPrivateStringMap, writePrivateStringMap } from "./privateJsonStore.js";

const BOUND_LIBRARY_CONFIG_KEY = "boundLibraryId";
const PENDING_CROSS_NAMESPACE_NOTICE_CONFIG_KEY = "pendingCrossNamespaceDemotionNotice";

export interface AttachBindingState {
  boundLibraryId: string | null;
  pendingStartupNotice: DesktopStartupNoticeKind | null;
}

function isLibraryId(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function readAttachBindingState(filePath: string): AttachBindingState {
  try {
    const current = readPrivateStringMap(filePath);
    return {
      boundLibraryId: isLibraryId(current[BOUND_LIBRARY_CONFIG_KEY])
        ? current[BOUND_LIBRARY_CONFIG_KEY]
        : null,
      pendingStartupNotice: isLibraryId(current[PENDING_CROSS_NAMESPACE_NOTICE_CONFIG_KEY])
        ? "cross-namespace-library-demoted"
        : null,
    };
  } catch {
    return {
      boundLibraryId: null,
      pendingStartupNotice: null,
    };
  }
}

export function persistBoundLibraryId(filePath: string, libraryId: string | null): void {
  const current = readPrivateStringMap(filePath);
  if (libraryId) current[BOUND_LIBRARY_CONFIG_KEY] = libraryId;
  else delete current[BOUND_LIBRARY_CONFIG_KEY];
  writePrivateStringMap(filePath, current);
}

/** 清绑定与记录待展示提示必须在同一次原子文件替换中完成。 */
export function persistDemotedCrossNamespaceBinding(
  filePath: string,
  libraryId: string,
): void {
  const current = readPrivateStringMap(filePath);
  delete current[BOUND_LIBRARY_CONFIG_KEY];
  current[PENDING_CROSS_NAMESPACE_NOTICE_CONFIG_KEY] = libraryId;
  writePrivateStringMap(filePath, current);
}

export function acknowledgeAttachStartupNotice(
  filePath: string,
  kind: DesktopStartupNoticeKind,
): void {
  if (kind !== "cross-namespace-library-demoted") return;
  const current = readPrivateStringMap(filePath);
  delete current[PENDING_CROSS_NAMESPACE_NOTICE_CONFIG_KEY];
  writePrivateStringMap(filePath, current);
}
