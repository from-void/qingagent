/**
 * 用户删除某素材（前端已二次确认）。后端从会话移除该 Material、清运行期缓存、
 * 删除其原始上传文件（无其它素材共享时），并回 `resourceRemoved` 帧。
 */
export type RemoveMaterial = { sessionId: string, materialId: string };
