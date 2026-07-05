import type { ToolCallBody } from "./ToolCallBody";
import type { ToolCallResult } from "./ToolCallResult";
import type { ToolCallStatus } from "./ToolCallStatus";
import type { ToolRenderTarget } from "./ToolRenderTarget";

export type ToolCallSpec = { id: string, name: string, render: ToolRenderTarget, status: ToolCallStatus, body: ToolCallBody, result: ToolCallResult | null, };
