export const DESKTOP_STARTUP_NOTICE_GET_CHANNEL = "qingagent:startup-notice-get";
export const DESKTOP_STARTUP_NOTICE_ACK_CHANNEL = "qingagent:startup-notice-ack";

export type DesktopStartupNoticeKind = "cross-namespace-library-demoted";

export function isDesktopStartupNoticeKind(value: unknown): value is DesktopStartupNoticeKind {
  return value === "cross-namespace-library-demoted";
}
