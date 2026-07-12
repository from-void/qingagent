import type { HandleCommandFn } from "./sessionActor";

let registeredHandler: HandleCommandFn | null = null;

export function registerBridgeCommandHandler(handler: HandleCommandFn): void {
  registeredHandler = handler;
}

export const dispatchBridgeCommand: HandleCommandFn = (...args) => {
  if (!registeredHandler) {
    throw new Error("Bridge command handler is not registered");
  }
  return registeredHandler(...args);
};
