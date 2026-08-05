export function isAllowedLinkHref(href: string): boolean {
  const value = href.trim();
  if (!value || /[\u0000-\u001f\u007f\s]/.test(value)) return false;
  const normalizedSeparators = value.replace(/\\/g, "/");
  return /^https?:\/\//i.test(value) || /^\/(?!\/)/.test(normalizedSeparators) || /^#[^\s]*$/.test(value);
}
