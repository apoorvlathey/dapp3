// Tiny JSON-snippet colorizer for inline help blocks (onboarding/interstitial).
// Only handles the shapes we actually emit: quoted keys, quoted string values,
// the literal `...` placeholder, and structural punctuation. Not a real parser.
const TOKEN =
  /("(?:[^"\\]|\\.)*")(?=\s*:)|("(?:[^"\\]|\\.)*")|(\.\.\.)|([{}\[\],])/g;

export function colorizeJson(src: string): string {
  const escaped = src
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(TOKEN, (m, key, str, dots, punct) => {
    if (key) return `<span class='tok-key'>${key}</span>`;
    if (str) return `<span class='tok-str'>${str}</span>`;
    if (dots) return `<span class='tok-comment'>...</span>`;
    if (punct) return `<span class='tok-punct'>${punct}</span>`;
    return m;
  });
}
