export const BROWSER_CREDENTIAL_CLEANUP_NOTICE_CHANNEL =
  "qingagent:browser-credential-cleanup-notice";

export interface BrowserCredentialCleanupNotice {
  paths: string[];
}
