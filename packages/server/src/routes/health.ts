import { Hono } from "hono";
import {
  getBrowserCapabilityState,
  hasHtmlToPdfRenderer,
} from "@qingagent/doc-render";

export const healthRoutes = new Hono();

healthRoutes.get("/health", (c) => {
  const browser = getBrowserCapabilityState();
  const customPdfRenderer = hasHtmlToPdfRenderer();
  return c.json({
    status: "ok",
    capabilities: {
      browser: {
        status: browser.status,
        sandbox: browser.sandbox,
        reason: browser.reason,
      },
      pdfExport: {
        enabled: customPdfRenderer || browser.status !== "unavailable",
        renderer: customPdfRenderer ? "custom" : "playwright",
      },
    },
  });
});
