export function emptyResult(name) {
  return { name, requests: [], environments: [], skipped: [] };
}

export function row(name, value, enabled = true) {
  return { name: String(name ?? ''), value: value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value), enabled };
}

export function splitUrl(raw) {
  const text = String(raw ?? '');
  const hash = text.indexOf('#');
  const clean = hash >= 0 ? text.slice(0, hash) : text;
  const q = clean.indexOf('?');
  if (q < 0) return { base: clean, query: [] };
  const query = clean
    .slice(q + 1)
    .split('&')
    .filter(Boolean)
    .map(part => {
      const eq = part.indexOf('=');
      const decode = s => {
        try {
          return decodeURIComponent(s.replace(/\+/g, ' '));
        } catch {
          return s;
        }
      };
      return eq < 0 ? row(decode(part), '') : row(decode(part.slice(0, eq)), decode(part.slice(eq + 1)));
    });
  return { base: clean.slice(0, q), query };
}
