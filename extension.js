import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importFiles } from './importers/index.js';
import { sandboxCode } from './scripts.js';

const MARKER = 'api-workspace.json';
const SECRETS = 'secrets.apisecret';
const REQUEST = 'apiworkspace.request';
const ENVIRONMENT = 'apiworkspace.environment';
const SECRETS_DOC = 'apiworkspace.secrets';
const TREE = 'apiworkspace.requests';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const BODY_TYPES = ['none', 'json', 'text', 'form', 'multipart'];
const AUTH_TYPES = ['none', 'bearer', 'basic'];
const SHOWN_BODY_LIMIT = 2 * 1024 * 1024;
const SCRIPT_BODY_LIMIT = 1024 * 1024;
const SCRIPT_TIMEOUT = 5000;
const HISTORY_LIMIT = 30;
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.json': 'application/json', '.txt': 'text/plain', '.csv': 'text/csv', '.xml': 'application/xml',
  '.html': 'text/html', '.zip': 'application/zip', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
};

const here = path.dirname(fileURLToPath(import.meta.url));

let saturn;
let broadcastTimer;
const open = new Map();
const running = new Map();
const responses = new Map();
const secretCache = new Map();
const runtimeVars = new Map();
let pageCache;

export function activate(api) {
  saturn = api;

  saturn.documents.registerEditor(REQUEST, {
    html: ctx => requestHtml(ctx),
    onMessage: (message, ctx) => onRequestMessage(message, ctx),
  });
  saturn.documents.registerEditor(ENVIRONMENT, {
    html: ctx => environmentHtml(ctx),
    onMessage: (message, ctx) => onEnvironmentMessage(message, ctx),
  });
  saturn.documents.registerEditor(SECRETS_DOC, {
    html: ctx => secretsHtml(ctx),
    onMessage: (message, ctx) => onSecretsMessage(message, ctx),
  });

  saturn.projectTypes.onCreate('apiworkspace', createWorkspace);

  saturn.commands.register('apiworkspace.newRequest', newRequest);
  saturn.commands.register('apiworkspace.newEnvironment', newEnvironment);
  saturn.commands.register('apiworkspace.switchEnvironment', switchEnvironment);
  saturn.commands.register('apiworkspace.import', importCommand);
  saturn.commands.register('apiworkspace.openSecrets', ctx => openSecrets(rootFor(ctx.projectPath, ctx.path) ?? ctx.projectPath, ctx.projectPath));
  saturn.commands.register('apiworkspace.send', ctx => ctx.path && send(ctx.path));
  saturn.commands.register('apiworkspace.copyCurl', ctx => ctx.path && postCurl(ctx.path));
  saturn.commands.register('apiworkspace.clearScriptVariables', ctx => clearScriptVariables(rootFor(ctx.projectPath, ctx.path) ?? ctx.projectPath, ctx.projectPath));

  saturn.panels.registerTree(TREE, { getChildren: treeChildren, onAction: treeAction });
  saturn.commands.register('apiworkspace.newFolder', ctx => newFolder(ctx.projectPath, path.join(rootFor(ctx.projectPath, ctx.path) ?? ctx.projectPath, 'requests')));

  saturn.search.registerProvider({ search: searchRequests, open: (id, ctx) => saturn.workspace.openFile(ctx.projectPath, id) });

  saturn.encryption.onDidChangeState(async ({ projectPath, state }) => {
    const root = rootFor(projectPath) ?? projectPath;
    if (state === 'removing') await decryptSecretsFile(root);
    else await refreshSecrets(root);
  });
  saturn.editor.onDidCloseFile(({ path: file }) => forget(file));
  saturn.workspace.onDidChangeFiles(scheduleBroadcast);
}

export function deactivate() {
  clearTimeout(broadcastTimer);
  for (const controller of running.values()) controller.abort();
  running.clear();
  open.clear();
  responses.clear();
  secretCache.clear();
  runtimeVars.clear();
}

function forget(file) {
  running.get(file)?.abort();
  running.delete(file);
  open.delete(file);
  responses.delete(file);
  secretCache.delete(file);
}


function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readDoc(text) {
  if (!str(text).trim()) return { value: {}, error: null };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { value: {}, error: 'The file should hold a JSON object.' };
    return { value, error: null };
  } catch (error) {
    return { value: {}, error: error.message };
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringify(value));
}

function stringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function embeddedRoot(projectPath) {
  return path.join(projectPath, '.saturn', 'api');
}

function keyPath(root) {
  return path.basename(root) === 'api' && path.basename(path.dirname(root)) === '.saturn' ? path.dirname(path.dirname(root)) : root;
}

function rootFor(projectPath, file) {
  const top = path.resolve(projectPath);
  if (file) {
    let dir = path.dirname(path.resolve(projectPath, file));
    while (dir.startsWith(top) && dir !== top) {
      if (fs.existsSync(path.join(dir, MARKER))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  if (fs.existsSync(path.join(top, MARKER))) return top;
  const embedded = embeddedRoot(top);
  if (fs.existsSync(path.join(embedded, MARKER))) return embedded;
  return null;
}

function slug(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

function uniqueFile(dir, base, ext) {
  let file = path.join(dir, `${base}${ext}`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base}-${n}${ext}`);
  return file;
}

function envId(file) {
  return path.basename(file, '.apienv');
}


function str(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function rows(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(row => row && typeof row === 'object')
    .map(row => ({ name: str(row.name), value: str(row.value), enabled: row.enabled !== false }));
}

function parts(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(row => row && typeof row === 'object')
    .map(row => ({ name: str(row.name), value: str(row.value), enabled: row.enabled !== false, type: row.type === 'file' ? 'file' : 'text' }));
}

function normalizeRequest(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const method = str(d.method).toUpperCase();
  const auth = d.auth && typeof d.auth === 'object' ? d.auth : {};
  const body = d.body && typeof d.body === 'object' ? d.body : {};
  const scripts = d.scripts && typeof d.scripts === 'object' ? d.scripts : {};
  const authType = AUTH_TYPES.includes(auth.type) ? auth.type : 'none';
  const bodyType = BODY_TYPES.includes(body.type) ? body.type : 'none';
  const out = {
    name: str(d.name),
    method: METHODS.includes(method) ? method : 'GET',
    url: str(d.url),
    query: rows(d.query),
    headers: rows(d.headers),
    auth:
      authType === 'bearer'
        ? { type: 'bearer', token: str(auth.token) }
        : authType === 'basic'
          ? { type: 'basic', username: str(auth.username), password: str(auth.password) }
          : { type: 'none' },
    body:
      bodyType === 'multipart'
        ? { type: 'multipart', multipart: parts(body.multipart) }
        : bodyType === 'form'
          ? { type: 'form', form: rows(body.form) }
          : bodyType === 'none'
            ? { type: 'none' }
            : { type: bodyType, text: str(body.text) },
  };
  const before = str(scripts.before);
  const after = str(scripts.after);
  if (before.trim() || after.trim()) out.scripts = { before, after };
  return out;
}

function normalizeEnvironment(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const secrets = Array.isArray(d.secrets) ? d.secrets.map(str).filter(Boolean) : [];
  return {
    name: str(d.name),
    variables: rows(d.variables).map(({ name, value }) => ({ name, value })),
    secrets: [...new Set(secrets)],
  };
}

function emptySecrets() {
  return { version: 1, environments: {} };
}

function normalizeSecretsFile(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const environments = {};
  for (const [env, values] of Object.entries(d.environments ?? {})) {
    if (!values || typeof values !== 'object') continue;
    environments[env] = {};
    for (const [name, value] of Object.entries(values)) environments[env][name] = str(value);
  }
  return d.plain === true ? { version: 1, plain: true, environments } : { version: 1, environments };
}


function pages() {
  if (!pageCache) {
    const read = name => fs.readFileSync(path.join(here, 'pages', name), 'utf8');
    pageCache = {
      css: read('style.css'),
      common: read('common.js'),
      request: read('request.html'),
      environment: read('environment.html'),
      secrets: read('secrets.html'),
    };
  }
  return pageCache;
}

function page(name, data) {
  const p = pages();
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<style>${p.css}</style><script>window.DATA = ${json};</script><script>${p.common}</script>${p[name]}`;
}

function track(ctx, kind, doc, invalid = false) {
  open.set(ctx.path, { projectPath: ctx.projectPath, root: rootFor(ctx.projectPath, ctx.path), kind, doc, invalid });
  return open.get(ctx.path);
}

function setDoc(file, doc) {
  const entry = open.get(file);
  if (entry) {
    entry.doc = doc;
    entry.invalid = false;
  }
  saturn.documents.setText(file, stringify(doc));
}

function scheduleBroadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    for (const [file, entry] of open) {
      if (entry.kind === 'request') saturn.documents.postMessage(file, { type: 'environments', ...environmentInfo(entry.root) });
    }
    saturn.panels.refresh(TREE);
  }, 300);
}


function environments(root) {
  if (!root) return [];
  const dir = path.join(root, 'environments');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter(name => name.endsWith('.apienv')).sort();
  } catch {
    return [];
  }
  return names.map(name => {
    const file = path.join(dir, name);
    const env = normalizeEnvironment(readJson(file, {}));
    return { id: envId(file), name: env.name || envId(file), file, env };
  });
}

function activeEnvironmentId(root) {
  if (!root) return null;
  const list = environments(root);
  const state = readJson(path.join(root, '.local', 'state.json'), {});
  const marker = readJson(path.join(root, MARKER), {});
  for (const id of [state.environment, marker.defaultEnvironment]) {
    if (id && list.some(env => env.id === id)) return id;
  }
  return list[0]?.id ?? null;
}

function environmentInfo(root) {
  return {
    environments: environments(root).map(({ id, name }) => ({ id, name })),
    active: activeEnvironmentId(root),
  };
}

function setActiveEnvironment(root, id) {
  const file = path.join(root, '.local', 'state.json');
  writeJson(file, { ...readJson(file, {}), environment: id });
  scheduleBroadcast();
}

function currentSecrets(root) {
  const file = path.resolve(root, SECRETS);
  for (const [key, entry] of secretCache) {
    if (path.resolve(key) === file && !entry.invalid) return entry.stored;
  }
  return normalizeSecretsFile(readJson(file, emptySecrets()));
}

async function variablesFor(root) {
  const vars = new Map();
  const secretNames = new Set();
  const secretValues = [];
  const id = activeEnvironmentId(root);
  if (!id) return { vars, secretNames, secretValues, environment: null };
  const env = environments(root).find(e => e.id === id);
  for (const { name, value } of env.env.variables) if (name) vars.set(name, value);
  for (const name of env.env.secrets) secretNames.add(name);
  if (env.env.secrets.length) {
    const file = currentSecrets(root);
    const stored = file.environments[id] ?? {};
    const wanted = env.env.secrets.filter(name => stored[name]);
    if (wanted.length && !file.plain) {
      const state = await saturn.encryption.state(keyPath(root));
      if (state !== 'unlocked') throw new Error('Unlock this workspace to use its secrets.');
    }
    for (const name of wanted) {
      const value = file.plain ? stored[name] : await saturn.encryption.decrypt(keyPath(root), stored[name]);
      vars.set(name, value);
      secretValues.push(value);
    }
  }
  return { vars, secretNames, secretValues, environment: env.name };
}

function requestHtml(ctx) {
  const { value, error } = readDoc(ctx.text);
  const doc = normalizeRequest(value);
  const entry = track(ctx, 'request', doc, !!error);
  const last = responses.get(ctx.path);
  return page('request', {
    doc,
    invalid: error,
    ...environmentInfo(entry.root),
    response: last ? last.shown : null,
    sending: running.has(ctx.path),
    history: historyFor(ctx.path),
    scriptsAvailable: typeof saturn.sandbox?.run === 'function',
  });
}

async function onRequestMessage(message, ctx) {
  const entry = open.get(ctx.path) ?? track({ ...ctx, text: '' }, 'request', normalizeRequest({}));
  switch (message.type) {
    case 'change':
      setDoc(ctx.path, normalizeRequest(message.doc));
      break;
    case 'reloaded':
      entry.doc = normalizeRequest(message.doc);
      entry.invalid = false;
      break;
    case 'send':
      if (message.doc) entry.doc = normalizeRequest(message.doc);
      await send(ctx.path);
      break;
    case 'cancel':
      running.get(ctx.path)?.abort();
      break;
    case 'setEnvironment':
      if (entry.root) setActiveEnvironment(entry.root, message.id);
      break;
    case 'saveResponse':
      await saveResponse(ctx.path);
      break;
    case 'copyCurl':
      await postCurl(ctx.path);
      break;
    case 'openSecrets':
      if (entry.root) openSecrets(entry.root, entry.projectPath);
      break;
    case 'chooseFile':
      await chooseFile(ctx.path, message.index);
      break;
    case 'newEnvironment': {
      const file = await createEnvironment(entry.projectPath, entry.root ?? entry.projectPath);
      if (file) setActiveEnvironment(entry.root ?? entry.projectPath, envId(file));
      break;
    }
    case 'editEnvironment': {
      const id = activeEnvironmentId(entry.root);
      const env = environments(entry.root).find(e => e.id === id);
      if (env) saturn.workspace.openFile(entry.projectPath, env.file);
      break;
    }
    case 'clearScriptVariables':
      clearScriptVariables(entry.root, entry.projectPath);
      break;
  }
}

async function chooseFile(file, index) {
  const entry = open.get(file);
  if (!entry) return;
  const picked = await saturn.window.showOpenDialog(entry.projectPath, { title: 'Choose File to Upload' });
  if (!picked?.length) return;
  const base = baseDirFor(file);
  const relative = path.relative(base, picked[0]);
  const value = relative.startsWith('..') || path.isAbsolute(relative) ? picked[0] : relative.split(path.sep).join('/');
  saturn.documents.postMessage(file, { type: 'fileChosen', index, value });
}

function fill(text, vars, missing) {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name) => {
    if (vars.has(name)) return vars.get(name);
    missing.add(name);
    return match;
  });
}

function baseDirFor(file) {
  const entry = open.get(file);
  return entry?.root ?? path.dirname(file);
}

function fullUrl(text) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
}

function originOf(doc, vars) {
  try {
    return new URL(fullUrl(fill(doc.url.trim(), vars, new Set()))).origin;
  } catch {
    return null;
  }
}

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function resolveDoc(doc, vars, baseDir) {
  const missing = new Set();
  const f = text => fill(text, vars, missing);

  const url = f(doc.url.trim());
  if (!url) throw new Error('Enter a URL first.');
  let target;
  try {
    target = new URL(fullUrl(url));
  } catch {
    throw new Error(`"${url}" isn't a valid URL.`);
  }
  for (const row of doc.query) if (row.enabled && row.name) target.searchParams.append(f(row.name), f(row.value));

  let headers = [];
  for (const row of doc.headers) if (row.enabled && row.name) headers.push([f(row.name), f(row.value)]);
  const has = name => headers.some(([key]) => key.toLowerCase() === name);
  if (doc.auth.type === 'bearer' && !has('authorization')) headers.push(['Authorization', `Bearer ${f(doc.auth.token)}`]);
  if (doc.auth.type === 'basic' && !has('authorization')) {
    const pair = Buffer.from(`${f(doc.auth.username)}:${f(doc.auth.password)}`).toString('base64');
    headers.push(['Authorization', `Basic ${pair}`]);
  }

  let body;
  let multipart = null;
  if (doc.method !== 'GET' && doc.method !== 'HEAD') {
    if (doc.body.type === 'json' || doc.body.type === 'text') {
      body = f(doc.body.text);
      if (!has('content-type')) headers.push(['Content-Type', doc.body.type === 'json' ? 'application/json' : 'text/plain']);
    } else if (doc.body.type === 'form') {
      const form = new URLSearchParams();
      for (const row of doc.body.form) if (row.enabled && row.name) form.append(f(row.name), f(row.value));
      body = form.toString();
      if (!has('content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
    } else if (doc.body.type === 'multipart') {
      multipart = [];
      const form = new FormData();
      for (const row of doc.body.multipart) {
        if (!row.enabled || !row.name) continue;
        const name = f(row.name);
        if (row.type === 'file') {
          const value = f(row.value).trim();
          if (!value) throw new Error(`Choose a file for "${name}".`);
          const file = path.resolve(baseDir, value);
          let data;
          try {
            data = fs.readFileSync(file);
          } catch {
            throw new Error(`Can't read the file for "${name}": ${value}`);
          }
          form.append(name, new Blob([data], { type: mimeOf(file) }), path.basename(file));
          multipart.push({ name, file });
        } else {
          const value = f(row.value);
          form.append(name, value);
          multipart.push({ name, value });
        }
      }
      body = form;
      headers = headers.filter(([key]) => key.toLowerCase() !== 'content-type');
    }
  }

  return { method: doc.method, url: target.toString(), headers, body, multipart, missing: [...missing] };
}

function runtimeFor(root) {
  const key = root ?? '';
  if (!runtimeVars.has(key)) runtimeVars.set(key, new Map());
  return runtimeVars.get(key);
}

function clearScriptVariables(root, projectPath) {
  const count = runtimeFor(root).size;
  runtimeVars.delete(root ?? '');
  saturn.window.showMessage(count ? `Cleared ${count} script variable${count === 1 ? '' : 's'}.` : 'There are no script variables.', { projectPath });
}

function templateOf(doc) {
  const query = doc.query.filter(r => r.enabled && r.name).map(r => (r.value ? `${r.name}=${r.value}` : r.name));
  return {
    method: doc.method,
    url: query.length ? `${doc.url}${doc.url.includes('?') ? '&' : '?'}${query.join('&')}` : doc.url,
    headers: doc.headers.filter(r => r.enabled && r.name).map(({ name, value }) => ({ name, value })),
    body: doc.body.type === 'json' || doc.body.type === 'text' ? doc.body.text : null,
  };
}

function applyTemplate(doc, changed) {
  if (!changed || typeof changed !== 'object') return doc;
  const next = structuredClone(doc);
  const method = str(changed.method).toUpperCase();
  if (METHODS.includes(method)) next.method = method;
  if (typeof changed.url === 'string') {
    const q = changed.url.indexOf('?');
    next.url = q < 0 ? changed.url : changed.url.slice(0, q);
    next.query = q < 0 ? [] : changed.url.slice(q + 1).split('&').filter(Boolean).map(part => {
      const eq = part.indexOf('=');
      return eq < 0 ? { name: part, value: '', enabled: true } : { name: part.slice(0, eq), value: part.slice(eq + 1), enabled: true };
    });
  }
  if (Array.isArray(changed.headers)) {
    next.headers = changed.headers.filter(h => h && h.name).map(h => ({ name: str(h.name), value: str(h.value), enabled: true }));
  }
  if (typeof changed.body === 'string') {
    if (next.body.type === 'json' || next.body.type === 'text') next.body.text = changed.body;
    else if (next.body.type === 'none' && changed.body) next.body = { type: 'text', text: changed.body };
  }
  return next;
}

function scriptVariables(merged, secretNames, runtime) {
  const out = {};
  for (const [name, value] of merged) if (!secretNames.has(name) || runtime.has(name)) out[name] = value;
  return out;
}

function redact(text, secretValues) {
  let out = text;
  for (const value of secretValues) if (value && value.length >= 4) out = out.split(value).join('[secret]');
  return out;
}

async function runScript(label, phase, script, input, notes) {
  if (typeof saturn.sandbox?.run !== 'function') {
    notes.errors.push(`${label} didn't run: this version of Saturn has no script sandbox.`);
    return null;
  }
  let out;
  try {
    out = await saturn.sandbox.run(sandboxCode(phase, script, input), { timeout: SCRIPT_TIMEOUT });
  } catch (error) {
    notes.errors.push(`${label}: ${error?.message ?? error}`);
    return null;
  }
  if (!out || typeof out !== 'object') return null;
  for (const line of Array.isArray(out.logs) ? out.logs : []) notes.logs.push(str(line));
  for (const t of Array.isArray(out.tests) ? out.tests : []) notes.tests.push({ name: str(t?.name), ok: t?.ok === true, error: t?.error ? str(t.error) : undefined });
  if (out.error) notes.errors.push(`${label}: ${str(out.error)}`);
  return out;
}

function applySets(set, runtime, merged) {
  if (!set || typeof set !== 'object') return;
  for (const [name, value] of Object.entries(set)) {
    if (!name) continue;
    if (value === null) {
      runtime.delete(name);
      merged.delete(name);
    } else {
      runtime.set(name, str(value));
      merged.set(name, str(value));
    }
  }
}

function setting(id, fallback) {
  const value = saturn.settings.get(id);
  return value === undefined || value === null || value === '' ? fallback : value;
}

async function send(file) {
  const entry = open.get(file);
  if (!entry || entry.invalid) return;
  running.get(file)?.abort();
  const controller = new AbortController();
  running.set(file, controller);
  saturn.documents.postMessage(file, { type: 'sending' });

  const seconds = Number(setting('timeout', '30')) || 30;
  const timer = setTimeout(() => controller.abort(new Error(`No response after ${seconds} seconds.`)), seconds * 1000);
  const started = performance.now();
  const notes = { tests: [], logs: [], errors: [] };
  let doc = entry.doc;
  let shown;
  try {
    const env = await variablesFor(entry.root);
    const runtime = runtimeFor(entry.root);
    const merged = new Map([...env.vars, ...runtime]);
    const planned = originOf(doc, env.vars);
    const origin = originOf(doc, merged);
    if (planned && origin && planned !== origin) {
      throw new Error(`A script variable changed where this request goes (${origin}), so it wasn't sent. Use "Clear Script Variables" to undo it.`);
    }

    if (doc.scripts?.before.trim()) {
      const out = await runScript('Before-send script', 'before', doc.scripts.before, {
        name: doc.name,
        request: templateOf(doc),
        variables: scriptVariables(merged, env.secretNames, runtime),
      }, notes);
      if (out) {
        applySets(out.set, runtime, merged);
        doc = applyTemplate(doc, out.request);
      }
      const now = originOf(doc, merged);
      if (origin && now !== origin) throw new Error(`The before-send script changed where this request goes (${now ?? 'an invalid URL'}), so it wasn't sent.`);
    }
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error('Cancelled.');

    const req = resolveDoc(doc, merged, baseDirFor(file));
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: setting('followRedirects', true) === false ? 'manual' : 'follow',
      signal: controller.signal,
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    const time = Math.round(performance.now() - started);
    const contentType = res.headers.get('content-type') ?? '';
    const headers = [...res.headers.entries()];

    if (doc.scripts?.after.trim()) {
      const text = isText(contentType) || !buffer.includes(0) ? buffer.subarray(0, SCRIPT_BODY_LIMIT).toString('utf8') : '';
      const out = await runScript('After-response script', 'after', doc.scripts.after, {
        name: doc.name,
        request: null,
        variables: scriptVariables(merged, env.secretNames, runtime),
        response: {
          status: res.status,
          statusText: res.statusText,
          time,
          headers: headers.map(([k, v]) => [k, redact(v, env.secretValues)]),
          body: redact(text, env.secretValues),
        },
      }, notes);
      if (out) applySets(out.set, runtime, merged);
    }

    shown = {
      ok: true,
      status: res.status,
      statusText: res.statusText,
      time,
      size: buffer.length,
      url: res.url || req.url,
      headers,
      contentType,
      body: shownBody(buffer, contentType),
      missing: req.missing,
      scripts: notes,
    };
    responses.set(file, { shown, buffer, contentType });
  } catch (error) {
    const reason = controller.signal.reason;
    const message = controller.signal.aborted
      ? reason instanceof Error ? reason.message : 'Cancelled.'
      : describeError(error);
    shown = { ok: false, error: message, time: Math.round(performance.now() - started), scripts: notes };
    responses.set(file, { shown, buffer: null, contentType: '' });
  } finally {
    clearTimeout(timer);
  }
  const items = addHistory(file, doc, shown);
  if (running.get(file) === controller) {
    running.delete(file);
    saturn.documents.postMessage(file, { type: 'response', response: shown, history: items });
  }
}

function historyFile(root) {
  return path.join(root, '.local', 'history.json');
}

function historyFor(file) {
  const root = open.get(file)?.root;
  if (!root) return [];
  const all = readJson(historyFile(root), {});
  const list = all[path.relative(root, file)];
  return Array.isArray(list) ? list : [];
}

function addHistory(file, doc, shown) {
  const root = open.get(file)?.root;
  if (!root) return [];
  const passed = shown.scripts?.tests.filter(t => t.ok).length ?? 0;
  const total = shown.scripts?.tests.length ?? 0;
  const item = {
    at: new Date().toISOString(),
    method: doc.method,
    url: doc.url,
    ...(shown.ok ? { status: shown.status, statusText: shown.statusText, size: shown.size } : { error: shown.error }),
    time: shown.time,
    ...(total ? { tests: `${passed}/${total}` } : {}),
  };
  const all = readJson(historyFile(root), {});
  const key = path.relative(root, file);
  const list = [item, ...(Array.isArray(all[key]) ? all[key] : [])].slice(0, HISTORY_LIMIT);
  all[key] = list;
  try {
    writeJson(historyFile(root), all);
  } catch {}
  return list;
}

function describeError(error) {
  const cause = error?.cause;
  if (cause?.code === 'ENOTFOUND') return `Couldn't find the server ${cause.hostname ?? ''}.`.replace(' .', '.');
  if (cause?.code === 'ECONNREFUSED') return 'The server refused the connection.';
  if (cause?.code === 'ECONNRESET') return 'The server closed the connection.';
  if (cause?.code?.startsWith?.('CERT_') || cause?.code === 'DEPTH_ZERO_SELF_SIGNED_CERT') return `Certificate problem: ${cause.code}.`;
  return cause?.message ?? error?.message ?? String(error);
}

function isText(contentType) {
  return /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|csv/i.test(contentType);
}

function shownBody(buffer, contentType) {
  if (/^image\/(png|jpe?g|gif|webp|svg\+xml)/i.test(contentType) && buffer.length <= SHOWN_BODY_LIMIT) {
    return { kind: 'image', dataUrl: `data:${contentType.split(';')[0]};base64,${buffer.toString('base64')}` };
  }
  if (!isText(contentType) && buffer.includes(0)) return { kind: 'binary' };
  const text = buffer.subarray(0, SHOWN_BODY_LIMIT).toString('utf8');
  const cut = buffer.length > SHOWN_BODY_LIMIT;
  if (/json/i.test(contentType) && !cut) {
    try {
      return { kind: 'json', text: JSON.stringify(JSON.parse(text), null, 2) };
    } catch {}
  }
  return { kind: 'text', text, cut };
}

async function saveResponse(file) {
  const last = responses.get(file);
  const entry = open.get(file);
  if (!last?.buffer || !entry) return;
  const ext = /json/i.test(last.contentType) ? 'json' : /html/i.test(last.contentType) ? 'html' : /xml/i.test(last.contentType) ? 'xml' : 'txt';
  const target = await saturn.window.showSaveDialog(entry.projectPath, {
    title: 'Save Response',
    defaultName: `${slug(entry.doc.name || path.basename(file, '.apireq'))}-response.${ext}`,
  });
  if (!target) return;
  fs.writeFileSync(target, last.buffer);
  saturn.window.showMessage(`Saved ${path.basename(target)}`, { projectPath: entry.projectPath });
}

function shellQuote(text) {
  if (saturn.platform === 'win32') return `"${text.replace(/"/g, '\\"')}"`;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

async function postCurl(file) {
  const entry = open.get(file);
  if (!entry || entry.invalid) return;
  try {
    const env = await variablesFor(entry.root);
    const merged = new Map([...env.vars, ...runtimeFor(entry.root)]);
    const req = resolveDoc(entry.doc, merged, baseDirFor(file));
    const parts = ['curl'];
    if (req.method !== 'GET') parts.push('-X', req.method);
    parts.push(shellQuote(req.url));
    for (const [name, value] of req.headers) parts.push('-H', shellQuote(`${name}: ${value}`));
    if (req.multipart) {
      for (const p of req.multipart) parts.push('-F', shellQuote(p.file ? `${p.name}=@${p.file}` : `${p.name}=${p.value}`));
    } else if (req.body !== undefined) {
      parts.push('--data-raw', shellQuote(req.body));
    }
    saturn.documents.postMessage(file, { type: 'curl', text: parts.join(' ') });
  } catch (error) {
    saturn.window.showMessage(error.message, { kind: 'error', projectPath: entry.projectPath });
  }
}

async function searchRequests(query, ctx) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const files = await saturn.workspace.findFiles(ctx.projectPath, '**/*.apireq');
  const results = [];
  for (const file of files) {
    const full = path.resolve(ctx.projectPath, file);
    const doc = normalizeRequest(readJson(full, {}));
    const label = doc.name || path.basename(full, '.apireq');
    const hay = `${label} ${doc.method} ${doc.url}`.toLowerCase();
    if (!hay.includes(q)) continue;
    results.push({
      id: full,
      label,
      detail: `${doc.method} ${doc.url}`.trim(),
      path: full,
    });
  }
  return results.slice(0, 50);
}


function environmentHtml(ctx) {
  const { value, error } = readDoc(ctx.text);
  const doc = normalizeEnvironment(value);
  track(ctx, 'environment', doc, !!error);
  return page('environment', { doc, id: envId(ctx.path), invalid: error });
}

function onEnvironmentMessage(message, ctx) {
  const entry = open.get(ctx.path);
  switch (message.type) {
    case 'change':
      setDoc(ctx.path, normalizeEnvironment(message.doc));
      scheduleBroadcast();
      break;
    case 'reloaded':
      if (entry) {
        entry.doc = normalizeEnvironment(message.doc);
        entry.invalid = false;
      }
      break;
    case 'openSecrets':
      if (entry?.root) openSecrets(entry.root, entry.projectPath);
      break;
  }
}


async function secretsData(file, text) {
  const entry = open.get(file);
  const root = entry?.root ?? path.dirname(file);
  const { value, error } = readDoc(text);
  if (error) {
    secretCache.set(file, { cache: {}, stored: emptySecrets(), broken: {}, invalid: true });
    return { state: 'invalid', invalid: error, environments: [], values: {}, broken: [] };
  }
  const stored = normalizeSecretsFile(value);
  const state = await saturn.encryption.state(keyPath(root));
  const declared = environments(root);
  const list = declared.map(({ id, name, env }) => ({ id, name, secrets: env.secrets }));
  for (const id of Object.keys(stored.environments)) {
    if (!list.some(env => env.id === id)) list.push({ id, name: id, secrets: [], missing: true });
  }
  const values = {};
  const cache = {};
  const broken = {};
  if (state === 'unlocked') {
    for (const [id, secrets] of Object.entries(stored.environments)) {
      values[id] = {};
      cache[id] = {};
      for (const [name, cipher] of Object.entries(secrets)) {
        try {
          const plain = await saturn.encryption.decrypt(keyPath(root), cipher);
          values[id][name] = plain;
          cache[id][name] = { plain, cipher };
        } catch {
          broken[id] = broken[id] ?? {};
          broken[id][name] = cipher;
        }
      }
    }
  }
  secretCache.set(file, { cache, stored, broken, invalid: false });
  const brokenList = Object.entries(broken).flatMap(([id, names]) => Object.keys(names).map(name => ({ id, name })));
  return { state, environments: list, values, broken: brokenList };
}

async function secretsHtml(ctx) {
  track(ctx, 'secrets', null);
  return page('secrets', await secretsData(ctx.path, ctx.text));
}

async function onSecretsMessage(message, ctx) {
  const entry = open.get(ctx.path);
  if (!entry) return;
  if (message.type === 'reload') {
    saturn.documents.postMessage(ctx.path, { type: 'data', data: await secretsData(ctx.path, message.text) });
    return;
  }
  if (message.type !== 'change' && message.type !== 'dropBroken') return;
  const previous = secretCache.get(ctx.path) ?? { cache: {}, stored: emptySecrets(), broken: {}, invalid: false };
  if (previous.invalid) return;
  if (message.type === 'dropBroken') {
    if (!previous.broken[message.id]?.[message.name]) return;
    delete previous.broken[message.id][message.name];
    delete previous.stored.environments[message.id]?.[message.name];
    saturn.documents.setText(ctx.path, stringify(previous.stored));
    saturn.documents.postMessage(ctx.path, { type: 'data', data: await secretsData(ctx.path, stringify(previous.stored)) });
    return;
  }
  if ((await saturn.encryption.state(keyPath(entry.root))) !== 'unlocked') {
    saturn.window.showMessage('Unlock this workspace to change its secrets.', { kind: 'warning', projectPath: entry.projectPath });
    return;
  }
  const next = { version: 1, environments: {} };
  const cache = {};
  for (const [id, secrets] of Object.entries(message.doc ?? {})) {
    next.environments[id] = {};
    cache[id] = {};
    for (const [name, plain] of Object.entries(secrets)) {
      if (!name) continue;
      const known = previous.cache[id]?.[name];
      const cipher = known && known.plain === plain ? known.cipher : await saturn.encryption.encrypt(keyPath(entry.root), str(plain));
      next.environments[id][name] = cipher;
      cache[id][name] = { plain: str(plain), cipher };
    }
  }
  for (const [id, names] of Object.entries(previous.broken)) {
    for (const [name, cipher] of Object.entries(names)) {
      if (next.environments[id]?.[name] !== undefined) {
        delete names[name];
        continue;
      }
      next.environments[id] = next.environments[id] ?? {};
      next.environments[id][name] = cipher;
    }
  }
  secretCache.set(ctx.path, { cache, stored: next, broken: previous.broken, invalid: false });
  saturn.documents.setText(ctx.path, stringify(next));
}

async function decryptSecretsFile(root) {
  const file = path.join(root, SECRETS);
  if (!fs.existsSync(file)) return;
  const { value, error } = readDoc(fs.readFileSync(file, 'utf8'));
  if (error) return;
  const stored = normalizeSecretsFile(value);
  if (stored.plain) return;
  const plain = { version: 1, plain: true, environments: {} };
  for (const [id, secrets] of Object.entries(stored.environments)) {
    plain.environments[id] = {};
    for (const [name, cipher] of Object.entries(secrets)) plain.environments[id][name] = await saturn.encryption.decrypt(keyPath(root), cipher);
  }
  writeJson(file, plain);
  const ignore = path.join(root, '.gitignore');
  const current = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
  if (!current.split(/\r?\n/).includes(SECRETS)) fs.writeFileSync(ignore, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${SECRETS}\n`);
  saturn.window.notify({
    title: 'Secrets are now stored as plain text',
    message: `${SECRETS} was added to .gitignore so the values aren't committed.`,
    kind: 'warning',
  });
}

async function refreshSecrets(projectPath) {
  for (const [file, entry] of open) {
    if (entry.kind !== 'secrets' || entry.root !== projectPath) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      text = '';
    }
    saturn.documents.postMessage(file, { type: 'data', data: await secretsData(file, text) });
  }
}

function openSecrets(root, projectPath) {
  const file = path.join(root, SECRETS);
  if (!fs.existsSync(file)) writeJson(file, emptySecrets());
  saturn.workspace.openFile(projectPath, file);
}


async function newRequest(ctx) {
  const root = rootFor(ctx.projectPath, ctx.path) ?? ctx.projectPath;
  const dir = ctx.path && ctx.path.endsWith('.apireq') ? path.dirname(path.resolve(ctx.projectPath, ctx.path)) : path.join(root, 'requests');
  await createRequest(ctx.projectPath, dir);
}

async function createRequest(projectPath, dir) {
  const name = await saturn.window.showInput(projectPath, { title: 'New Request', placeholder: 'Request name' });
  if (!name?.trim()) return;
  const file = uniqueFile(dir, slug(name), '.apireq');
  writeJson(file, normalizeRequest({ name: name.trim(), method: 'GET', url: '{{baseUrl}}/' }));
  scheduleBroadcast();
  saturn.workspace.openFile(projectPath, file);
}

async function newEnvironment(ctx) {
  await createEnvironment(ctx.projectPath, rootFor(ctx.projectPath, ctx.path) ?? ctx.projectPath);
}

async function createEnvironment(projectPath, root) {
  const name = await saturn.window.showInput(projectPath, { title: 'New Environment', placeholder: 'Environment name, for example Staging' });
  if (!name?.trim()) return null;
  const file = uniqueFile(path.join(root, 'environments'), slug(name), '.apienv');
  writeJson(file, normalizeEnvironment({ name: name.trim(), variables: [{ name: 'baseUrl', value: '' }] }));
  scheduleBroadcast();
  saturn.workspace.openFile(projectPath, file);
  return file;
}

function folderName(name) {
  return name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/^\.+/, '').slice(0, 80);
}

async function newFolder(projectPath, dir) {
  const name = await saturn.window.showInput(projectPath, { title: 'New Folder', placeholder: 'Folder name' });
  const clean = name ? folderName(name) : '';
  if (!clean) return;
  let target = path.join(dir, clean);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${clean} ${n}`);
  fs.mkdirSync(target, { recursive: true });
  scheduleBroadcast();
}

function treeChildren(parentId, ctx) {
  const root = rootFor(ctx.projectPath);
  if (!root) {
    if (parentId) return [];
    return [{
      id: 'setup',
      label: 'Add API Requests to This Project',
      description: '.saturn/api',
      tooltip: 'Keeps requests, environments and secrets in this project\'s .saturn/api folder.',
      hasChildren: false,
      actions: [{ id: 'setup', label: 'Set Up' }],
    }];
  }
  if (!parentId) {
    const active = environments(root).find(e => e.id === activeEnvironmentId(root));
    return [
      {
        id: 'group:requests',
        label: 'Requests',
        hasChildren: true,
        actions: [
          { id: 'newRequest', label: 'New Request…' },
          { id: 'newFolder', label: 'New Folder…' },
          { id: 'import', label: 'Import…' },
        ],
      },
      {
        id: 'group:environments',
        label: 'Environments',
        hasChildren: true,
        description: active ? active.name : undefined,
        actions: [{ id: 'newEnvironment', label: 'New Environment…' }],
      },
      {
        id: 'secrets',
        label: 'Secrets',
        hasChildren: false,
        open: fs.existsSync(path.join(root, SECRETS)) ? { path: path.join(root, SECRETS) } : undefined,
        actions: [{ id: 'openSecrets', label: 'Open Secrets' }],
      },
    ];
  }
  if (parentId === 'group:requests') return folderItems(path.join(root, 'requests'));
  if (parentId.startsWith('dir:')) return folderItems(parentId.slice(4));
  if (parentId === 'group:environments') {
    const active = activeEnvironmentId(root);
    return environments(root).map(env => ({
      id: `env:${env.file}`,
      label: env.name,
      hasChildren: false,
      description: env.id === active ? 'in use' : undefined,
      tooltip: `${env.env.variables.length} variables, ${env.env.secrets.length} secrets`,
      open: { path: env.file },
      actions: [
        ...(env.id === active ? [] : [{ id: 'useEnvironment', label: 'Use' }]),
        { id: 'rename', label: 'Rename…' },
        { id: 'delete', label: 'Delete' },
      ],
    }));
  }
  return [];
}

function folderItems(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const folders = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    .map(e => {
      const full = path.join(dir, e.name);
      return {
        id: `dir:${full}`,
        label: e.name,
        hasChildren: true,
        actions: [
          { id: 'newRequest', label: 'New Request…' },
          { id: 'newFolder', label: 'New Folder…' },
          { id: 'rename', label: 'Rename…' },
          { id: 'delete', label: 'Delete' },
        ],
      };
    });
  const requests = entries
    .filter(e => e.isFile() && e.name.endsWith('.apireq'))
    .map(e => {
      const full = path.join(dir, e.name);
      const doc = normalizeRequest(readJson(full, {}));
      return { full, doc, label: doc.name || path.basename(e.name, '.apireq') };
    })
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }))
    .map(({ full, doc, label }) => ({
      id: `req:${full}`,
      label,
      badge: doc.method,
      tooltip: `${doc.method} ${doc.url}`,
      hasChildren: false,
      open: { path: full },
      actions: [
        { id: 'duplicate', label: 'Duplicate' },
        { id: 'rename', label: 'Rename…' },
        { id: 'delete', label: 'Delete' },
      ],
    }));
  return [...folders, ...requests];
}

async function treeAction(actionId, item, ctx) {
  if (actionId === 'setup') return setUpEmbedded(ctx.projectPath);
  const root = rootFor(ctx.projectPath);
  if (!root) return;
  const [kind, ...restParts] = item.id.split(':');
  const target = restParts.join(':');
  const requestsDir = path.join(root, 'requests');
  switch (actionId) {
    case 'newRequest':
      return createRequest(ctx.projectPath, kind === 'dir' ? target : requestsDir);
    case 'newFolder':
      return newFolder(ctx.projectPath, kind === 'dir' ? target : requestsDir);
    case 'import':
      return importCommand(ctx);
    case 'newEnvironment':
      return createEnvironment(ctx.projectPath, root);
    case 'openSecrets':
      return openSecrets(root, ctx.projectPath);
    case 'useEnvironment':
      return setActiveEnvironment(root, envId(target));
    case 'duplicate':
      return duplicateRequest(ctx.projectPath, target);
    case 'rename':
      return renameItem(ctx.projectPath, kind, target);
    case 'delete':
      return deleteItem(ctx.projectPath, root, kind, target);
  }
}

function docName(file, normalize) {
  const entry = open.get(file);
  if (entry?.doc) return entry.doc;
  return normalize(readJson(file, {}));
}

async function duplicateRequest(projectPath, file) {
  const doc = docName(file, normalizeRequest);
  const name = `${doc.name || path.basename(file, '.apireq')} copy`;
  const copy = uniqueFile(path.dirname(file), slug(name), '.apireq');
  writeJson(copy, normalizeRequest({ ...doc, name }));
  scheduleBroadcast();
  saturn.workspace.openFile(projectPath, copy);
}

async function renameItem(projectPath, kind, target) {
  if (kind === 'dir') {
    const name = await saturn.window.showInput(projectPath, { title: 'Rename Folder', value: path.basename(target) });
    const clean = name ? folderName(name) : '';
    if (!clean || clean === path.basename(target)) return;
    const next = path.join(path.dirname(target), clean);
    if (fs.existsSync(next)) {
      saturn.window.showMessage(`There's already a folder called "${clean}".`, { kind: 'warning', projectPath });
      return;
    }
    const busy = [...open.keys()].some(f => f.startsWith(target + path.sep));
    if (busy) {
      saturn.window.showMessage('Close the requests in this folder before renaming it.', { kind: 'warning', projectPath });
      return;
    }
    fs.renameSync(target, next);
    scheduleBroadcast();
    return;
  }
  const isRequest = kind === 'req';
  const normalize = isRequest ? normalizeRequest : normalizeEnvironment;
  const doc = docName(target, normalize);
  const current = doc.name || path.basename(target, path.extname(target));
  const name = await saturn.window.showInput(projectPath, { title: isRequest ? 'Rename Request' : 'Rename Environment', value: current });
  if (!name?.trim() || name.trim() === current) return;
  const clean = name.trim();
  if (open.has(target)) {
    if (isRequest) saturn.documents.postMessage(target, { type: 'setName', name: clean });
    else setDoc(target, normalize({ ...doc, name: clean }));
  } else {
    writeJson(target, normalize({ ...doc, name: clean }));
  }
  if (isRequest) {
    const wanted = `${slug(clean)}.apireq`;
    if (wanted !== path.basename(target) && !fs.existsSync(path.join(path.dirname(target), wanted))) {
      await saturn.workspace.renameFile(projectPath, target, wanted);
    }
  }
  scheduleBroadcast();
}

async function deleteItem(projectPath, root, kind, target) {
  const trash = path.join(root, '.local', 'trash');
  fs.mkdirSync(trash, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(trash, `${stamp} ${path.basename(target)}`);
  try {
    fs.renameSync(target, dest);
  } catch (error) {
    saturn.window.showMessage(`Couldn't delete: ${error.message}`, { kind: 'error', projectPath });
    return;
  }
  if (kind === 'env') dropEnvironmentSecrets(root, envId(target));
  scheduleBroadcast();
  saturn.window.showMessage(`Moved ${path.basename(target)} to .local/trash`, { projectPath });
}

function dropEnvironmentSecrets(root, id) {
  const file = path.join(root, SECRETS);
  const openKey = [...secretCache.keys()].find(key => path.resolve(key) === path.resolve(file));
  const cached = openKey ? secretCache.get(openKey) : null;
  let stored;
  if (cached && !cached.invalid) stored = cached.stored;
  else {
    if (!fs.existsSync(file)) return;
    const { value, error } = readDoc(fs.readFileSync(file, 'utf8'));
    if (error) return;
    stored = normalizeSecretsFile(value);
  }
  if (!stored.environments[id]) return;
  const next = { ...stored, environments: { ...stored.environments } };
  delete next.environments[id];
  if (cached && !cached.invalid) {
    delete cached.cache[id];
    delete cached.broken[id];
    cached.stored = next;
    saturn.documents.setText(openKey, stringify(next));
    secretsData(openKey, stringify(next)).then(data => saturn.documents.postMessage(openKey, { type: 'data', data }));
  } else {
    writeJson(file, next);
  }
}

async function switchEnvironment(ctx) {
  const root = rootFor(ctx.projectPath, ctx.path) ?? ctx.projectPath;
  const list = environments(root);
  if (!list.length) {
    saturn.window.showMessage('This workspace has no environments yet.', { kind: 'warning', projectPath: ctx.projectPath });
    return;
  }
  const active = activeEnvironmentId(root);
  const answer = await saturn.window.showInput(ctx.projectPath, {
    title: `Switch Environment (${list.map(env => env.name).join(', ')})`,
    value: list.find(env => env.id === active)?.name ?? '',
  });
  if (!answer?.trim()) return;
  const wanted = answer.trim().toLowerCase();
  const match = list.find(env => env.name.toLowerCase() === wanted || env.id === wanted);
  if (!match) {
    saturn.window.showMessage(`There's no environment called "${answer.trim()}".`, { kind: 'warning', projectPath: ctx.projectPath });
    return;
  }
  setActiveEnvironment(root, match.id);
  saturn.window.showMessage(`Using ${match.name}`, { projectPath: ctx.projectPath });
}


async function importCommand(ctx) {
  const root = rootFor(ctx.projectPath, ctx.path) ?? ctx.projectPath;
  const picked = await saturn.window.showOpenDialog(ctx.projectPath, {
    title: 'Import Postman, Bruno or OpenAPI',
    multiple: true,
    filters: [
      { name: 'Postman, Bruno or OpenAPI', extensions: ['json', 'yaml', 'yml', 'bru'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (!picked?.length) return;

  let results;
  try {
    results = importFiles(picked);
  } catch (error) {
    saturn.window.notify({ title: "Couldn't import", message: error.message, kind: 'error' });
    return;
  }

  const notes = new Set();
  let requestCount = 0;
  let envCount = 0;
  let firstFile = null;
  const pendingSecrets = [];

  for (const result of results) {
    for (const note of result.skipped) notes.add(note);
    if (result.requests.length) {
      const collectionDir = uniqueDir(path.join(root, 'requests'), slug(result.name));
      for (const { folder, doc } of result.requests) {
        const dir = path.join(collectionDir, ...folder.map(slug));
        const file = uniqueFile(dir, slug(doc.name || 'request'), '.apireq');
        writeJson(file, normalizeRequest(doc));
        firstFile = firstFile ?? file;
        requestCount++;
      }
    }
    for (const env of result.environments) {
      const file = uniqueFile(path.join(root, 'environments'), slug(env.name || result.name), '.apienv');
      writeJson(file, normalizeEnvironment(env));
      envCount++;
      if (Object.keys(env.secretValues ?? {}).length) pendingSecrets.push({ id: envId(file), values: env.secretValues });
    }
  }

  if (pendingSecrets.length) {
    const saved = await importSecretValues(root, pendingSecrets);
    if (!saved) notes.add('Some secret values were not imported because this workspace is not unlocked. Their names were kept; set the values in Secrets.');
  }

  if (envCount) scheduleBroadcast();
  if (firstFile) saturn.workspace.openFile(ctx.projectPath, firstFile);

  const summary = `Imported ${requestCount} request${requestCount === 1 ? '' : 's'} and ${envCount} environment${envCount === 1 ? '' : 's'}.`;
  if (notes.size) {
    const list = [...notes];
    saturn.window.notify({
      title: summary,
      message: `${list.slice(0, 8).join('\n')}${list.length > 8 ? `\n…and ${list.length - 8} more.` : ''}`,
      kind: 'warning',
    });
  } else {
    saturn.window.showMessage(summary, { projectPath: ctx.projectPath });
  }
}

function uniqueDir(parent, base) {
  let dir = path.join(parent, base);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(parent, `${base}-${n}`);
  return dir;
}

async function importSecretValues(root, pending) {
  if ((await saturn.encryption.state(keyPath(root))) !== 'unlocked') return false;
  const file = path.join(root, SECRETS);
  const stored = normalizeSecretsFile(readDoc(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').value);
  for (const { id, values } of pending) {
    stored.environments[id] = stored.environments[id] ?? {};
    for (const [name, value] of Object.entries(values)) stored.environments[id][name] = await saturn.encryption.encrypt(keyPath(root), value);
  }
  writeJson(file, stored);
  return true;
}

async function setUpEmbedded(projectPath) {
  const root = embeddedRoot(projectPath);
  if (fs.existsSync(path.join(root, MARKER))) return;
  await createWorkspace({ projectPath: root, name: path.basename(projectPath) });
  scheduleBroadcast();
  saturn.workspace.openFile(projectPath, path.join(root, 'requests', 'example.apireq'));
}

async function createWorkspace(ctx) {
  const root = ctx.projectPath;
  writeJson(path.join(root, MARKER), { name: ctx.name, version: 1, defaultEnvironment: 'local' });
  writeJson(
    path.join(root, 'environments', 'local.apienv'),
    normalizeEnvironment({ name: 'Local', variables: [{ name: 'baseUrl', value: 'https://httpbin.org' }] }),
  );
  writeJson(
    path.join(root, 'requests', 'example.apireq'),
    normalizeRequest({
      name: 'Example',
      method: 'GET',
      url: '{{baseUrl}}/get',
      query: [{ name: 'hello', value: 'world' }],
      headers: [{ name: 'Accept', value: 'application/json' }],
    }),
  );
  fs.writeFileSync(path.join(root, '.gitignore'), '.local/\n');
}
