/**
 * 用户要求重试解析某个已上传素材。后端按 fileId 找原始字节，重跑解析并回
 * `resourceUpserted` 帧，不经过模型、不占会话轮次。
 */
export type ReparseMaterial = { sessionId: string, fileId: string };
