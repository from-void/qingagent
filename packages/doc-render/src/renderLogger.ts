export interface DocRenderLogger {
  warn(message: string, metadata?: Record<string, unknown>): void;
}

let logger: DocRenderLogger = console;

export function setDocRenderLogger(nextLogger: DocRenderLogger): void {
  logger = nextLogger;
}

export function getDocRenderLogger(): DocRenderLogger {
  return logger;
}
