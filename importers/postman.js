import { emptyResult, row, splitUrl } from './shared.js';

export function fromPostman(collection, fallback) {
  const result = emptyResult(collection.info?.name || fallback);
  const rootAuth = collection.auth;
  walk(collection.item ?? [], [], rootAuth, result);
  const variables = (collection.variable ?? []).filter(v => v && v.key && !v.disabled);
  if (variables.length) {
    result.environments.push({
      name: result.name,
      variables: variables.filter(v => v.type !== 'secret').map(v => ({ name: v.key, value: text(v.value) })),
      secrets: variables.filter(v => v.type === 'secret').map(v => v.key),
      secretValues: Object.fromEntries(variables.filter(v => v.type === 'secret' && v.value).map(v => [v.key, text(v.value)])),
    });
  }
  return result;
}

export function fromPostmanEnvironment(env, fallback) {
  const result = emptyResult(env.name || fallback);
  const values = (env.values ?? []).filter(v => v && v.key && v.enabled !== false);
  result.environments.push({
    name: env.name || fallback,
    variables: values.filter(v => v.type !== 'secret').map(v => ({ name: v.key, value: text(v.value) })),
    secrets: values.filter(v => v.type === 'secret').map(v => v.key),
    secretValues: Object.fromEntries(values.filter(v => v.type === 'secret' && v.value).map(v => [v.key, text(v.value)])),
  });
  return result;
}

function text(value) {
  return value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
}

function walk(items, folder, inheritedAuth, result) {
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const auth = item.auth && item.auth.type !== 'inherit' ? item.auth : inheritedAuth;
    if (Array.isArray(item.item)) {
      walk(item.item, [...folder, item.name || 'Folder'], auth, result);
      continue;
    }
    if (!item.request) continue;
    try {
      result.requests.push({ folder, doc: request(item, auth, result) });
    } catch (error) {
      result.skipped.push(`${item.name || 'A request'}: ${error.message}`);
    }
  }
}

function request(item, inheritedAuth, result) {
  const req = typeof item.request === 'string' ? { method: 'GET', url: item.request } : item.request;
  const name = item.name || 'Untitled';
  const url = typeof req.url === 'string' ? { raw: req.url } : req.url ?? {};
  let raw = url.raw ?? buildRaw(url);
  for (const v of url.variable ?? []) {
    if (!v?.key) continue;
    const value = v.value != null && v.value !== '' ? text(v.value) : `{{${v.key}}}`;
    raw = raw.replace(new RegExp(`/:${escape(v.key)}(?=/|\\?|#|$)`, 'g'), `/${value}`);
  }
  const split = splitUrl(raw);
  const query = Array.isArray(url.query)
    ? url.query.filter(q => q && q.key != null).map(q => row(q.key, q.value, !q.disabled))
    : split.query;

  const headers = (Array.isArray(req.header) ? req.header : [])
    .filter(h => h && h.key)
    .map(h => row(h.key, h.value, !h.disabled));

  const doc = { name, method: (req.method || 'GET').toUpperCase(), url: split.base, query, headers, auth: { type: 'none' }, body: { type: 'none' } };

  const auth = req.auth && req.auth.type !== 'inherit' ? req.auth : inheritedAuth;
  applyAuth(doc, auth, name, result);
  applyBody(doc, req.body, name, result);
  return doc;
}

function buildRaw(url) {
  const protocol = url.protocol ? `${url.protocol}://` : '';
  const host = Array.isArray(url.host) ? url.host.join('.') : url.host ?? '';
  const p = Array.isArray(url.path) ? url.path.join('/') : url.path ?? '';
  return `${protocol}${host}${p ? `/${p}` : ''}`;
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function authValue(auth, type, key) {
  const part = auth[type];
  if (Array.isArray(part)) return text(part.find(p => p?.key === key)?.value);
  if (part && typeof part === 'object') return text(part[key]);
  return '';
}

function applyAuth(doc, auth, name, result) {
  if (!auth || auth.type === 'noauth') return;
  if (auth.type === 'bearer') doc.auth = { type: 'bearer', token: authValue(auth, 'bearer', 'token') };
  else if (auth.type === 'basic') doc.auth = { type: 'basic', username: authValue(auth, 'basic', 'username'), password: authValue(auth, 'basic', 'password') };
  else if (auth.type === 'apikey') {
    const key = authValue(auth, 'apikey', 'key') || 'X-API-Key';
    const value = authValue(auth, 'apikey', 'value');
    if (authValue(auth, 'apikey', 'in') === 'query') doc.query.push(row(key, value));
    else doc.headers.push(row(key, value));
  } else if (auth.type === 'oauth2') {
    doc.auth = { type: 'bearer', token: authValue(auth, 'oauth2', 'accessToken') || '{{token}}' };
    result.skipped.push(`${name}: OAuth 2 was turned into a bearer token. Set {{token}} or the token yourself.`);
  } else {
    result.skipped.push(`${name}: ${auth.type} auth isn't supported, so it was left out.`);
  }
}

function applyBody(doc, body, name, result) {
  if (!body || body.disabled || !body.mode) return;
  if (body.mode === 'raw') {
    const language = body.options?.raw?.language;
    const raw = text(body.raw);
    const json = language === 'json' || (!language && /^\s*[[{]/.test(raw));
    doc.body = { type: json ? 'json' : 'text', text: raw };
    if (!json && language && language !== 'text') {
      const types = { xml: 'application/xml', html: 'text/html', javascript: 'application/javascript' };
      if (types[language] && !doc.headers.some(h => h.name.toLowerCase() === 'content-type')) doc.headers.push(row('Content-Type', types[language]));
    }
  } else if (body.mode === 'urlencoded') {
    doc.body = { type: 'form', form: (body.urlencoded ?? []).filter(f => f?.key).map(f => row(f.key, f.value, !f.disabled)) };
  } else if (body.mode === 'formdata') {
    const fields = (body.formdata ?? []).filter(f => f?.key);
    const files = fields.filter(f => f.type === 'file');
    doc.body = { type: 'form', form: fields.filter(f => f.type !== 'file').map(f => row(f.key, f.value, !f.disabled)) };
    if (files.length) result.skipped.push(`${name}: file fields aren't supported yet, so ${files.map(f => f.key).join(', ')} were left out. It's sent as a URL-encoded form.`);
    else if (fields.length) result.skipped.push(`${name}: multipart form data is sent as a URL-encoded form.`);
  } else if (body.mode === 'graphql') {
    let variables = {};
    try {
      variables = body.graphql?.variables ? JSON.parse(body.graphql.variables) : {};
    } catch {}
    doc.body = { type: 'json', text: JSON.stringify({ query: body.graphql?.query ?? '', variables }, null, 2) };
  } else if (body.mode === 'file') {
    result.skipped.push(`${name}: file bodies aren't supported yet, so the body was left out.`);
  }
}
