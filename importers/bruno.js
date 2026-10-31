import fs from 'node:fs';
import path from 'node:path';
import { emptyResult, row, splitUrl } from './shared.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const SKIP = new Set(['node_modules', '.git', 'environments']);

export function fromBrunoFolder(dir) {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(dir, 'bruno.json'), 'utf8'));
  } catch {}
  const result = emptyResult(config.name || path.basename(dir));
  const collection = readBlocks(path.join(dir, 'collection.bru'));
  walk(dir, [], collection, result);
  const envDir = path.join(dir, 'environments');
  let envFiles = [];
  try {
    envFiles = fs.readdirSync(envDir).filter(f => f.endsWith('.bru')).sort();
  } catch {}
  for (const file of envFiles) result.environments.push(environment(parseBru(fs.readFileSync(path.join(envDir, file), 'utf8')), path.basename(file, '.bru')));
  return result;
}

export function fromBrunoFiles(dir, files) {
  const result = emptyResult(path.basename(dir));
  const collection = readBlocks(path.join(dir, 'collection.bru'));
  for (const file of files.sort()) {
    const blocks = parseBru(fs.readFileSync(file, 'utf8'));
    if (blocks.vars || blocks['vars:secret']) result.environments.push(environment(blocks, path.basename(file, '.bru')));
    else addRequest(blocks, file, [], collection, result);
  }
  return result;
}

function readBlocks(file) {
  try {
    return parseBru(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function walk(dir, folder, collection, result) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const requests = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
      const sub = path.join(dir, entry.name);
      const meta = readBlocks(path.join(sub, 'folder.bru')).meta;
      walk(sub, [...folder, dict(meta).name || entry.name], collection, result);
    } else if (entry.name.endsWith('.bru') && entry.name !== 'folder.bru' && entry.name !== 'collection.bru') {
      const file = path.join(dir, entry.name);
      const blocks = parseBru(fs.readFileSync(file, 'utf8'));
      requests.push({ seq: Number(dict(blocks.meta).seq) || 0, blocks, file });
    }
  }
  requests.sort((a, b) => a.seq - b.seq || a.file.localeCompare(b.file));
  for (const { blocks, file } of requests) addRequest(blocks, file, folder, collection, result);
}

export function parseBru(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks = {};
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^([\w:-]+)\s*([{[])\s*$/);
    if (!open) continue;
    const close = open[2] === '{' ? '}' : ']';
    const body = [];
    i++;
    while (i < lines.length && lines[i].trimEnd() !== close) body.push(lines[i++]);
    blocks[open[1]] = body;
  }
  return blocks;
}

function dict(lines) {
  const out = {};
  for (const line of lines ?? []) {
    const t = line.trim();
    if (!t) continue;
    const colon = t.indexOf(':');
    if (colon < 0) continue;
    out[t.slice(0, colon).trim()] = t.slice(colon + 1).trim();
  }
  return out;
}

function rows(lines) {
  const out = [];
  for (const line of lines ?? []) {
    const t = line.trim();
    if (!t) continue;
    const colon = t.indexOf(':');
    if (colon < 0) continue;
    const key = t.slice(0, colon).trim();
    const disabled = key.startsWith('~');
    out.push(row(disabled ? key.slice(1) : key, t.slice(colon + 1).trim(), !disabled));
  }
  return out;
}

function list(lines) {
  return (lines ?? [])
    .map(l => l.trim().replace(/,$/, '').trim())
    .filter(Boolean)
    .map(name => (name.startsWith('~') ? null : name))
    .filter(Boolean);
}

function raw(lines) {
  const body = lines ?? [];
  const indent = Math.min(...body.filter(l => l.trim()).map(l => l.length - l.trimStart().length), Infinity);
  const n = indent === Infinity ? 0 : indent;
  return body.map(l => l.slice(n)).join('\n').replace(/\n+$/, '');
}

function environment(blocks, fallback) {
  const vars = rows(blocks.vars).filter(r => r.enabled);
  return {
    name: fallback,
    variables: vars.map(({ name, value }) => ({ name, value })),
    secrets: list(blocks['vars:secret']),
    secretValues: {},
  };
}

function addRequest(blocks, file, folder, collection, result) {
  const meta = dict(blocks.meta);
  const name = meta.name || path.basename(file, '.bru');
  if (meta.type && meta.type !== 'http' && meta.type !== 'graphql') {
    result.skipped.push(`${name}: ${meta.type} requests aren't supported, so it was left out.`);
    return;
  }
  const method = METHODS.find(m => blocks[m]);
  if (!method) {
    result.skipped.push(`${name}: no method found, so it was left out.`);
    return;
  }
  const info = dict(blocks[method]);
  const split = splitUrl(info.url);
  const query = blocks['params:query'] ? rows(blocks['params:query']) : split.query;
  let url = split.base;
  for (const p of rows(blocks['params:path'])) {
    if (p.enabled && p.value) url = url.replace(new RegExp(`/:${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=/|$)`, 'g'), `/${p.value}`);
  }
  url = url.replace(/\/:([A-Za-z_][\w-]*)/g, '/{{$1}}');

  const doc = {
    name,
    method: method.toUpperCase(),
    url,
    query,
    headers: [...rows(collection.headers), ...rows(blocks.headers)],
    auth: { type: 'none' },
    body: { type: 'none' },
  };

  const authMode = info.auth === 'inherit' ? dict(collection.auth).mode : info.auth;
  const authBlocks = info.auth === 'inherit' ? collection : blocks;
  if (authMode === 'bearer') doc.auth = { type: 'bearer', token: dict(authBlocks['auth:bearer']).token ?? '' };
  else if (authMode === 'basic') {
    const b = dict(authBlocks['auth:basic']);
    doc.auth = { type: 'basic', username: b.username ?? '', password: b.password ?? '' };
  } else if (authMode === 'apikey') {
    const k = dict(authBlocks['auth:apikey']);
    if (k.key) (k.placement === 'queryparams' ? doc.query : doc.headers).push(row(k.key, k.value ?? ''));
  } else if (authMode && authMode !== 'none' && authMode !== 'inherit') {
    result.skipped.push(`${name}: ${authMode} auth isn't supported, so it was left out.`);
  }

  const bodyMode = info.body;
  if (bodyMode === 'json' && blocks['body:json']) doc.body = { type: 'json', text: raw(blocks['body:json']) };
  else if ((bodyMode === 'text' || bodyMode === 'xml' || bodyMode === 'sparql') && blocks[`body:${bodyMode}`]) {
    doc.body = { type: 'text', text: raw(blocks[`body:${bodyMode}`]) };
    const types = { xml: 'application/xml', sparql: 'application/sparql-query' };
    if (types[bodyMode] && !doc.headers.some(h => h.name.toLowerCase() === 'content-type')) doc.headers.push(row('Content-Type', types[bodyMode]));
  } else if (bodyMode === 'formUrlEncoded' || bodyMode === 'form-urlencoded') {
    doc.body = { type: 'form', form: rows(blocks['body:form-urlencoded']) };
  } else if (bodyMode === 'multipartForm' || bodyMode === 'multipart-form') {
    const fields = rows(blocks['body:multipart-form']);
    const files = fields.filter(f => f.value.startsWith('@file('));
    doc.body = { type: 'form', form: fields.filter(f => !f.value.startsWith('@file(')) };
    result.skipped.push(
      files.length
        ? `${name}: file fields aren't supported yet, so ${files.map(f => f.name).join(', ')} were left out. It's sent as a URL-encoded form.`
        : `${name}: multipart form data is sent as a URL-encoded form.`,
    );
  } else if (bodyMode === 'graphql' && blocks['body:graphql']) {
    let variables = {};
    try {
      variables = JSON.parse(raw(blocks['body:graphql:vars']) || '{}');
    } catch {}
    doc.body = { type: 'json', text: JSON.stringify({ query: raw(blocks['body:graphql']), variables }, null, 2) };
  }

  result.requests.push({ folder, doc });
}
