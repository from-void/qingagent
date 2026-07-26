export function newClientMessageId(): string {
  return `m-user-${crypto.randomUUID()}`;
}
