export type TableSelection = {
	/** 行或列选区。 */
	axis: "row" | "column",
	/** 0-based inclusive，且必须小于等于 endIndex。 */
	startIndex: number,
	/** 0-based inclusive。 */
	endIndex: number,
	/** 选取时范围内各单元格纯文本按物理顺序计算的短签名。 */
	signature?: string,
};

/**
 * 对按物理顺序采集的单元格纯文本计算稳定短签名。
 * JSON 长度边界可避免 `["ab", "c"]` 与 `["a", "bc"]` 一类拼接歧义。
 */
export function tableSelectionTextSignature(cellTexts: readonly string[]): string {
	const serialized = JSON.stringify(cellTexts);
	let hash = 0x811c9dc5;
	for (let index = 0; index < serialized.length; index += 1) {
		hash ^= serialized.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
