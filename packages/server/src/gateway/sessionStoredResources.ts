import {
  completeSessionDeletion,
  getSessionDeletion,
  listActiveSessionResourceOwners,
  listSessionResources,
  markSessionAssetsDeleted,
  removeSessionResource,
  type SessionDeletionPhase,
} from "@qingagent/db";
import { omSidecarThreadId } from "@qingagent/contract-ts";
import { purgeStoredFile } from "../lib/uploadStorage";

export async function deleteSessionStoredResources(
  sessionId: string,
): Promise<SessionDeletionPhase> {
  const record = await getSessionDeletion(sessionId);
  if (!record) throw new Error(`Missing session deletion tombstone: ${sessionId}`);
  let phase = record.phase;
  if (phase === "completed") return phase;

  if (phase === "database_deleted") {
    const resources = await listSessionResources(sessionId);
    for (const resource of resources) {
      const otherOwners = await listActiveSessionResourceOwners(
        resource.resourceId,
        sessionId,
      );
      if (otherOwners.length > 0) continue;
      if (!(await purgeStoredFile(resource.resourceId))) {
        throw new Error(`Failed to delete session resource: ${resource.resourceId}`);
      }
    }
    phase = await markSessionAssetsDeleted(sessionId);
  }

  if (phase === "assets_deleted") {
    await completeSessionDeletion(sessionId, [omSidecarThreadId(sessionId)]);
    return "completed";
  }
  return phase;
}

/** 生产删除入口：core 负责 DB/Mastra，server 负责本机 uploads。 */
export async function deleteSessionWithStoredResources(
  sessionId: string,
): Promise<SessionDeletionPhase> {
  // 保持资源清理模块可独立测试，避免仅导入它就初始化完整 agent/默认数据库。
  const { deleteSessionThread } = await import("@qingagent/core");
  const phase = await deleteSessionThread(sessionId);
  if (phase === "completed") return phase;
  return deleteSessionStoredResources(sessionId);
}

/** 用户手动移除最后一份素材引用时也复用同一份归属判定。 */
export async function deleteStoredResourceForSession(
  sessionId: string,
  resourceId: string,
): Promise<boolean> {
  const otherOwners = await listActiveSessionResourceOwners(resourceId, sessionId);
  if (otherOwners.length === 0 && !(await purgeStoredFile(resourceId))) return false;
  await removeSessionResource(sessionId, resourceId);
  return true;
}
