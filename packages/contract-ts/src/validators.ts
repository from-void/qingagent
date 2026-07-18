export function isAllowedLinkHref(href: string): boolean {
  const value = href.trim();
  if (!value || /[\u0000-\u001f\u007f\s]/.test(value)) return false;
  return /^https?:\/\//i.test(value) || /^\/(?!\/)/.test(value) || /^#[^\s]*$/.test(value);
}
