export const DEFAULT_DESKTOP_PORT = 21823;

export function resolveDesktopPort(rawPort: string | undefined): number {
  if (rawPort === undefined || rawPort.trim() === "") return DEFAULT_DESKTOP_PORT;
  const port = Number(rawPort);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_DESKTOP_PORT;
}

export async function listenWithDesktopPortFallback(
  preferredPort: number,
  listen: (port: number) => Promise<number>,
): Promise<{ port: number; fellBack: boolean }> {
  try {
    return { port: await listen(preferredPort), fellBack: false };
  } catch (error) {
    if (preferredPort === 0 || !isAddressInUse(error)) throw error;
    return { port: await listen(0), fellBack: true };
  }
}

function isAddressInUse(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EADDRINUSE");
}
