/**
 * 用户编辑某素材摘要后提交。后端写入 Material.summary 并回 `resourceUpdated`
 * 帧（含 metadata.fileId）。允许模型后续覆盖，不引入用户编辑保护标记。
 */
export type UpdateMaterialSummary = { sessionId: string, materialId: string, summary: string };
