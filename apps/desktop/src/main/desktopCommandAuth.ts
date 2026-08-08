const DESKTOP_COMMAND_MUTATION_PATHS = new Set([
  "/api/v1/commands",
]);

export function isDesktopCommandMutationPath(pathname: string): boolean {
  return DESKTOP_COMMAND_MUTATION_PATHS.has(pathname);
}

export function withCommandAuthorization(
  source: Record<string, string>,
  token: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (name.toLowerCase() !== "authorization") headers[name] = value;
  }
  headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function authorizeDesktopDevCommandRequest(input: {
  url: string;
  method: string;
  webContentsId?: number;
  requestHeaders: Record<string, string>;
}, options: {
  rendererId: number;
  rendererOrigin: string;
  token: string;
}): Record<string, string> {
  if (input.webContentsId !== options.rendererId || input.method !== "POST") {
    return input.requestHeaders;
  }
  try {
    const url = new URL(input.url);
    if (
      url.origin !== options.rendererOrigin
      || !isDesktopCommandMutationPath(url.pathname)
    ) {
      return input.requestHeaders;
    }
  } catch {
    return input.requestHeaders;
  }
  return withCommandAuthorization(input.requestHeaders, options.token);
}

export function desktopDevCommandUrlPatterns(rendererOrigin: string): string[] {
  return [...DESKTOP_COMMAND_MUTATION_PATHS]
    .map((pathname) => `${rendererOrigin}${pathname}*`);
}
