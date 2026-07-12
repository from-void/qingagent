/**
 * Bridge facade. Domain implementations live in sibling modules; keep this
 * path stable for routes, tests, and shutdown hooks.
 */
export { handleCommand } from "./commandRouter";
export {
  normalizeClientTraceId,
  parseOrigin,
  recordCommandSpan,
  resolveCommandSessionId,
  type CommandSpanHandle,
  type Origin,
} from "./commandTracing";
export {
  DEFAULT_USER_VERSION_WINDOW_MS,
  readUserVersionWindowMs,
  USER_VERSION_WINDOW_MS,
} from "./docWriteConfig";
export { refreshBrowserFolderSourceFileCountsForBridgeConnection } from "./folderSourceRefresh";
export { findMaterial } from "./materialLookup";
export { emitRestoreFrames } from "./restoreFrames";
export {
  collectRestoreFrames,
  disposeAllSessionsForShutdown,
  drainActiveTurnsForShutdown,
  findSessionByPatch,
  findSessionByReviewBatchId,
  forgetSession,
  getOrRestoreSession,
  getSession,
  sessionExists,
  sessionManager,
} from "./sessionLifecycle";
