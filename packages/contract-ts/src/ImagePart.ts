export type ImagePart = {
  /** Display label */
  label: string;
  /** base64-encoded image data, or a URL path.
   *  null = 无预览图(站点无 og:image 或图片下载失败),前端渲染简化文字卡。 */
  src: string | null;
  /** 'base64' or 'url' */
  srcKind: "base64" | "url";
  /** Original page URL */
  sourceUrl: string | null;
  /** Width in pixels */
  width: number | null;
  /** Height in pixels */
  height: number | null;
};
