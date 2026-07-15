import type { RoleAvatarKind } from "./roleReviewCatalog";

export function RoleAvatar({ kind }: { kind: RoleAvatarKind }) {
  const content = (() => {
    switch (kind) {
      case "engineer":
        return <>
          <circle cx="32" cy="25" r="10" /><path d="M22 24h7m6 0h7m-13 0c0 4-7 4-7 0m13 0c0 4 7 4 7 0m-13 0h6" />
          <path d="M18 48c2-8 8-12 14-12s12 4 14 12M15 19l-5 5 5 5m34-10 5 5-5 5" />
        </>;
      case "hr":
        return <>
          <rect x="14" y="13" width="27" height="37" /><circle cx="27.5" cy="24" r="5" /><path d="M20 38c1.5-5 4.5-7 7.5-7s6 2 7.5 7M20 43h13" />
          <circle cx="44" cy="42" r="7" /><path d="m49 47 6 6" />
        </>;
      case "client":
        return <>
          <path d="M10 28l9-8 10 7-7 7-7-2-5 5m44-9-9-8-10 7 7 7 7-2 5 5" />
          <path d="m22 34 8 8c2 2 4 2 6 0l8-8m-19 3 5 5m9-5-5 5M14 37l-4-4m40 4 4-4" />
        </>;
      case "academic":
        return <>
          <path d="m12 23 20-10 20 10-20 10Z" /><path d="M20 28v9c5 5 19 5 24 0v-9m8-5v13" />
          <circle cx="32" cy="45" r="6" /><path d="M22 55c2-5 5-7 10-7s8 2 10 7" />
        </>;
      case "editor":
        return <>
          <circle cx="25" cy="24" r="9" /><path d="M13 47c2-8 7-12 12-12 4 0 7 2 10 6" />
          <path d="m31 49 5-13 14-14 6 6-14 14Z" /><path d="m48 24 6 6M36 36l6 6m-11 7 5-13" />
        </>;
      case "newcomer":
        return <>
          <circle cx="28" cy="22" r="8" /><path d="M15 43c2-8 7-12 13-12s11 4 13 12" />
          <rect x="35" y="34" width="18" height="16" /><path d="M40 39h8m-8 5h5M47 13v8m-4-4h8" />
        </>;
      case "interviewer":
        return <>
          <circle cx="24" cy="24" r="9" /><path d="M12 48c2-9 7-13 12-13s10 4 12 13" />
          <path d="M36 14h17v15H43l-5 5v-5h-2Z" /><path d="M43 20c0-2 1.5-3 3.5-3s3.5 1 3.5 3c0 3-3.5 2-3.5 5m0 1.5v.5" />
        </>;
      case "legal":
        return <>
          <circle cx="32" cy="16" r="4" /><path d="M32 20v31m-13 0h26M16 27h32M32 23 18 27m14-4 14 4" />
          <path d="m18 27-7 13h14Zm28 0-7 13h14Z" />
        </>;
      case "boss":
        return <>
          <circle cx="32" cy="21" r="9" /><path d="M15 52c2-12 8-18 17-18s15 6 17 18" />
          <path d="m21 37 7 8 4-6 4 6 7-8M29 44l3 8 3-8M25 16c4-4 11-4 14 0" />
        </>;
      case "investor":
        return <>
          <circle cx="20" cy="25" r="8" /><path d="M8 49c2-9 6-13 12-13s10 4 12 13" />
          <path d="M34 43V17h22M38 37l6-7 5 4 7-11m0 0h-6m6 0v6" />
        </>;
      case "competitor":
        return <>
          <path d="M18 53V13m28 40V13M18 15c8-4 12 5 20 1v16c-8 4-12-5-20-1Zm28 0c-8-4-12 5-20 1" />
          <path d="M26 42c2-4 4-6 6-6s4 2 6 6m-16 7h20" />
        </>;
      case "beginner":
        return <>
          <circle cx="25" cy="29" r="10" /><path d="M11 52c2-9 7-13 14-13s12 4 14 13" />
          <path d="M37 13h17v16H44l-5 5v-5h-2Z" /><path d="M44 19c0-2 1.5-3 3.5-3s3.5 1 3.5 3c0 3-3.5 2-3.5 5m0 2v.5" />
        </>;
      case "generic":
        return <><circle cx="32" cy="23" r="10" /><path d="M15 52c2-12 8-18 17-18s15 6 17 18" /></>;
    }
  })();

  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-avatar-kind={kind}
    >
      {content}
    </svg>
  );
}
