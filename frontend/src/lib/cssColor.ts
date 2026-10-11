/** Resolves `var(--token)` to its computed colour (canvas charts cannot use CSS variables directly). */
export function resolveCssColor(color: string): string {
  if (!color.startsWith('var(')) return color;
  const name = color.slice(4, -1).trim();
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888888';
}
