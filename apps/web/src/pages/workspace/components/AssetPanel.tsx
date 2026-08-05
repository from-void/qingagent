/** 文件类型(决定图标样式):覆盖素材区支持的所有类型 + 兜底。 */
export type FileKind =
  | "pdf"
  | "word"
  | "csv"
  | "excel"
  | "ppt"
  | "markdown"
  | "text"
  | "image"
  | "webpage"
  | "generic";

const KIND_META: Record<FileKind, { label: string; color: string }> = {
  pdf: { label: "PDF", color: "#d6453a" },
  word: { label: "DOC", color: "#2b6cb0" },
  csv: { label: "CSV", color: "#1f8a4c" },
  excel: { label: "XLS", color: "#1f8a4c" },
  ppt: { label: "PPT", color: "#d2622b" },
  markdown: { label: "MD", color: "#4a6b78" },
  text: { label: "TXT", color: "#6b7280" },
  image: { label: "IMG", color: "#4f9468" },
  webpage: { label: "WEB", color: "#2f8a98" },
  generic: { label: "FILE", color: "#7a8290" },
};

/** 按文件名扩展名 + mime 判定文件类型。 */
export function fileKind(name: string, mime?: string): FileKind {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const m = mime ?? "";
  if (ext === "pdf" || m === "application/pdf") return "pdf";
  if (ext === "doc" || ext === "docx" || m.includes("word") || m.includes("wordprocessing"))
    return "word";
  if (ext === "csv" || m === "text/csv") return "csv";
  if (
    ["xls", "xlsx"].includes(ext) ||
    m.includes("excel") ||
    m.includes("spreadsheet")
  )
    return "excel";
  if (["ppt", "pptx"].includes(ext) || m.includes("powerpoint") || m.includes("presentation"))
    return "ppt";
  if (ext === "md" || ext === "markdown" || m.includes("markdown")) return "markdown";
  if (ext === "txt" || ext === "log" || m === "text/plain") return "text";
  if (
    ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext) ||
    m.startsWith("image/")
  )
    return "image";
  if (lower.startsWith("http") || m.includes("html")) return "webpage";
  return "generic";
}

/**
 * 文件类型图标:真实文件图标观感——白色文档页 + 折角 + 内容线 + 底部彩色类型条(白字)。
 * 不是裸的大号英文,类型字只在底部小色条里。图片/网页有专门图形。
 */
export function FileIcon({ kind }: { kind: FileKind }) {
  const { label, color } = KIND_META[kind];
  const mono = "'SF Mono','Roboto Mono',ui-monospace,Menlo,monospace";
  const gid = `fipg-${kind}`;
  return (
    <svg className="az-fileicon" viewBox="0 0 52 64" role="img" aria-label={label}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#eef0f3" />
        </linearGradient>
      </defs>
      {/* 页面 */}
      <path
        d="M9 3 H31 L43 15 V57 A4 4 0 0 1 39 61 H9 A4 4 0 0 1 5 57 V7 A4 4 0 0 1 9 3 Z"
        fill={`url(#${gid})`}
        stroke="#cfd4dc"
        strokeWidth="1"
      />
      {/* 折角 */}
      <path d="M31 3 L43 15 H35 A4 4 0 0 1 31 11 Z" fill="#dde1e8" />
      <path d="M31 3 L43 15 H35 A4 4 0 0 1 31 11 Z" fill="#000" opacity="0.05" />
      {kind === "image" ? (
        <g>
          <rect x="11" y="22" width="30" height="20" rx="2.5" fill="#fff" stroke={color} strokeWidth="1.3" />
          <circle cx="18" cy="29" r="2.8" fill={color} />
          <path d="M12 41 L21 31 L27 37 L31 33 L40 41 Z" fill={color} opacity="0.5" />
        </g>
      ) : kind === "webpage" ? (
        <g fill="none" stroke={color} strokeWidth="1.6">
          <circle cx="26" cy="33" r="10" />
          <ellipse cx="26" cy="33" rx="4.3" ry="10" />
          <line x1="16" y1="33" x2="36" y2="33" />
          <line x1="18" y1="27" x2="34" y2="27" />
          <line x1="18" y1="39" x2="34" y2="39" />
        </g>
      ) : (
        <>
          <rect x="12" y="24" width="24" height="2.6" rx="1.3" fill="#d3d8e0" />
          <rect x="12" y="31" width="24" height="2.6" rx="1.3" fill="#d3d8e0" />
          <rect x="12" y="38" width="15" height="2.6" rx="1.3" fill="#d3d8e0" />
        </>
      )}
      {/* 底部类型色条 */}
      <rect x="5" y="46" width="30" height="13" rx="3" fill={color} />
      <text
        x="20"
        y="55.4"
        fontSize="8"
        fontWeight="700"
        fill="#fff"
        textAnchor="middle"
        fontFamily={mono}
        letterSpacing="0"
      >
        {label}
      </text>
    </svg>
  );
}
