export class SessionDeletionInProgressError extends Error {
  constructor() {
    super("Session deletion is in progress");
    this.name = "SessionDeletionInProgressError";
  }
}

export class SessionDeletedError extends Error {
  constructor() {
    super("Session has been deleted");
    this.name = "SessionDeletedError";
  }
}
