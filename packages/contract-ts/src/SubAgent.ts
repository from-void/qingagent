import type { SubAgentStatus } from "./SubAgentStatus";

export type SubAgent = { id: string, spawnedBy: string, rootTaskId: string, name: string, status: SubAgentStatus, description: string, };
