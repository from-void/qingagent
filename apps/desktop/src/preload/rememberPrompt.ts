import { ipcRenderer } from "electron";
import {
  REMEMBER_PROMPT_DECISION_CHANNEL,
  type RememberPromptDecision,
} from "../main/trustedRememberUi.js";

window.addEventListener("DOMContentLoaded", () => {
  let decided = false;
  const decide = (decision: RememberPromptDecision, event: Event) => {
    if (decided || !event.isTrusted) return;
    decided = true;
    ipcRenderer.send(REMEMBER_PROMPT_DECISION_CHANNEL, decision);
  };
  const cancel = document.querySelector<HTMLButtonElement>("#prompt-cancel");
  const close = document.querySelector<HTMLButtonElement>("#prompt-close");
  const remember = document.querySelector<HTMLButtonElement>("#prompt-remember");
  cancel?.addEventListener("click", (event) => decide("cancel", event));
  close?.addEventListener("click", (event) => decide("cancel", event));
  remember?.addEventListener("click", (event) => decide("remember", event));
  cancel?.focus();
});
