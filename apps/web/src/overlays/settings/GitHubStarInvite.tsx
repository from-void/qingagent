import type { ReactNode } from "react";

export function SettingsExternalLink({
  href,
  wf,
  className,
  children,
}: {
  href: string;
  wf: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-wf={wf}
    >
      {children}
    </a>
  );
}

export function GitHubStarInvite({ repoUrl, wf }: { repoUrl: string; wf: string }) {
  return (
    <div className="qj-star-invite" data-wf={wf}>
      <SettingsExternalLink href={repoUrl} wf={`${wf}Link`} className="qj-star-action">
        <StarIcon />
        <span>给个 Star</span>
      </SettingsExternalLink>
    </div>
  );
}

function StarIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m12 3 2.75 5.57 6.15.9-4.45 4.33 1.05 6.12L12 17.03l-5.5 2.89 1.05-6.12L3.1 9.47l6.15-.9L12 3Z" />
    </svg>
  );
}
