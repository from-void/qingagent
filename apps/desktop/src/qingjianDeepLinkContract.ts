export const QINGJIAN_OPEN_SESSION_CHANNEL = "qingagent:qingjian-open-session";

export interface QingjianOpenSessionIntent {
  engineSessionId: string;
  result?: "found" | "not-found" | "unavailable";
}
