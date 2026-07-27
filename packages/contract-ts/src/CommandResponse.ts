export interface CommandFailedResponse {
  error: {
    code: "COMMAND_FAILED";
    message: string;
  };
  requestId?: string;
}
