import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { healthRoutes } from "./routes/health";
import { homeRoutes } from "./routes/home";
import { historyRoutes } from "./routes/history";
import { streamRoutes } from "./routes/stream";
import { uploadRoutes } from "./routes/upload";
import { askMoreRoutes } from "./routes/askMore";
import { exportRoutes } from "./routes/export";
import { skillsRoutes } from "./routes/skills";
import { credentialsRoutes } from "./routes/credentials";
import { clientLogRoutes } from "./routes/clientlog";
import { debugRoutes } from "./routes/debug";
import { dataAdminRoutes } from "./routes/dataAdmin";
import { folderBridgeRoutes } from "./routes/folderBridge";
import { modelSettingsRoutes } from "./routes/modelSettings";
import { searchSettingsRoutes } from "./routes/searchSettings";
import { usageRoutes } from "./routes/usage";
import { capabilitiesRoutes } from "./routes/capabilities";
import { diagnosticsRoutes } from "./routes/diagnostics";
import { externalRoutes } from "./routes/external";
import { authRoutes } from "./routes/auth";
import { folderEntriesRoutes } from "./routes/folderEntries";
import { cleanupOldFolderSourceCaches } from "@qingagent/core";
import { authTokenMiddleware } from "./lib/authToken";
import { externalTokenMiddleware } from "./lib/externalAuth";
import { csrfMutationGuard, isTrustedOrigin } from "./lib/trustedOrigin";

export const app = new Hono();

void cleanupOldFolderSourceCaches();

function redactAuthInLog(message: string): string {
  return message.replace(/([?&]auth=)[^&\s]+/gi, "$1[REDACTED]");
}

// Middleware
// CORS:默认同源 + localhost 家族放行,QINGAGENT_TRUSTED_ORIGINS 扩展(复用 isTrustedOrigin 单一真源)。
// credentials:true 是 cookie 鉴权(步骤 B)必需,且带 credentials 时浏览器禁止 ACAO=*,所以 * 必须退役。
// 无 Origin(同源/curl)时回调收到空串,返回 null 不加 ACAO——同源请求本就不受 CORS 约束。
app.use(
  "*",
  cors({
    origin: (origin) => (origin && isTrustedOrigin(origin) ? origin : null),
    credentials: true,
  }),
);
app.use("*", logger((message: string, ...rest: string[]) => console.log(redactAuthInLog(message), ...rest)));
app.use("/api/*", csrfMutationGuard);
app.use("/api/*", authTokenMiddleware);
app.use("/api/v1/external/*", externalTokenMiddleware);

// Routes
app.route("/", healthRoutes);
app.route("/api/v1", authRoutes);
app.route("/api/v1", homeRoutes);
app.route("/api/v1", historyRoutes);
app.route("/api/v1", streamRoutes);
app.route("/api/v1", uploadRoutes);
app.route("/api/v1", askMoreRoutes);
app.route("/api/v1", exportRoutes);
app.route("/api/v1", skillsRoutes);
app.route("/api/v1", credentialsRoutes);
app.route("/api/v1", clientLogRoutes);
app.route("/api/v1", debugRoutes);
app.route("/api/v1", dataAdminRoutes);
app.route("/api/v1", folderBridgeRoutes);
app.route("/api/v1", modelSettingsRoutes);
app.route("/api/v1", searchSettingsRoutes);
app.route("/api/v1", usageRoutes);
app.route("/api/v1", capabilitiesRoutes);
app.route("/api/v1", folderEntriesRoutes);
app.route("/api/v1", diagnosticsRoutes);
app.route("/api/v1/external", externalRoutes);
