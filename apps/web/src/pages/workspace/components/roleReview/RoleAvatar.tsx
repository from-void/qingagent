import type { RoleAvatarKind } from "./roleReviewCatalog";

export function RoleAvatar({ kind }: { kind: RoleAvatarKind }) {
  const badge = (() => {
    switch (kind) {
      case "beginner":
        return <>
          <path d="M38 40c4-1 7.5.5 10 3v14c-2.5-2.5-6-3.5-10-2.5Z" />
          <path d="M58 40c-4-1-7.5.5-10 3v14c2.5-2.5 6-3.5 10-2.5Z" />
        </>;
      case "engineer":
        return <>
          <path d="m44 40-6 7 6 7" />
          <path d="m52 40 6 7-6 7M50 38l-4 18" />
        </>;
      case "hr":
        return <>
          <circle cx="46" cy="45" r="7" />
          <path d="m51 50 7 7" />
        </>;
      case "client":
        return <>
          <rect x="38" y="42" width="20" height="14" />
          <path d="M43 42v-4h10v4M38 48h20M46 48v2h4v-2" />
        </>;
      case "academic":
        return <>
          <path d="m37 43 11-6 11 6-11 6Z" />
          <path d="M41 47v5c4 3 10 3 14 0v-5M59 43v9" />
        </>;
      case "editor":
        return <>
          <path d="m48 37 10 10-10 11-10-11Z" />
          <path d="M48 40v12" />
          <circle cx="48" cy="53" r="1.5" fill="currentColor" stroke="none" />
        </>;
      case "newcomer":
        return <>
          <rect x="39" y="39" width="18" height="18" />
          <path d="M44 39v-2h8v2M48 44v8M44 48h8" />
        </>;
      case "interviewer":
        return <>
          <path d="M38 39h20v14H48l-6 5v-5h-4Z" />
          <path d="M45 44c.5-2 2-3 4-3 2.5 0 4 1.5 4 3.5 0 3-4 3-4 5.5M49 53v.5" />
        </>;
      case "legal":
        return <>
          <path d="M48 37v20M39 41h18M48 39l-8 2m8-2 8 2" />
          <path d="m40 41-4 9h8Zm16 0-4 9h8ZM43 57h10" />
        </>;
      case "boss":
        return <>
          <path d="m48 37 3 6 7 1-5 5 1 8-6-3.5-6 3.5 1-8-5-5 7-1Z" />
        </>;
      case "investor":
        return <>
          <path d="m38 55 7-7 5 4 8-12" />
          <path d="M52 40h6v6" />
        </>;
      case "competitor":
        return <>
          <path d="M39 58V38" />
          <path d="M39 40c6-4 11 4 18 0v11c-7 4-12-4-18 0Z" />
        </>;
      case "generic":
        return null;
    }
  })();

  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-avatar-kind={kind}
    >
      <g data-avatar-part="person">
        <circle cx="21" cy="19" r="8" />
        <path d="M7 45c1.5-8 6.5-13 14-13s12.5 5 14 13" />
      </g>
      {badge ? <g data-avatar-part="badge">{badge}</g> : null}
    </svg>
  );
}
