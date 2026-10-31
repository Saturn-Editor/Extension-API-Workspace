import { emptyResult, row } from './shared.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

export function fromOpenApi(spec, fallback) {
  const result = emptyResult(spec.info?.title || fallback);
  const resolve = resolver(spec);
  const swagger = !!spec.swagger;
  const schemes = (swagger ? spec.securityDefinitions : spec.components?.securitySchemes) ?? {};
  const secrets = new Set();

  for (const [route, rawItem] of Object.entries(spec.paths ?? {})) {
    const item = resolve(rawItem) ?? {};
    for (const method of METHODS) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;
      const name = op.summary || op.operationId || `${method.toUpperCase()} ${route}`;
      try {
        const params = mergeParams(item.parameters, op.parameters, resolve);
        const doc = {
          name,
          method: method.toUpperCase(),
          url: `{{baseUrl}}${route.replace(/\{([^}]+)\}/g, '{{$1}}')}`,
          query: [],
          headers: [],
          auth: { type: 'none' },
          body: { type: 'none' },
        };
        for (const p of params) {
          if (p.in === 'query') doc.query.push(row(p.name, paramValue(p, resolve), !!p.required));
          else if (p.in === 'header' && !/^(accept|content-type|authorization)$/i.test(p.name)) doc.headers.push(row(p.name, paramValue(p, resolve), !!p.required));
        }
        if (swagger) swaggerBody(doc, op, params, spec, resolve);
        else openApiBody(doc, op, resolve);
        const accept = acceptType(op, spec, swagger);
        if (accept) doc.headers.unshift(row('Accept', accept));
        applySecurity(doc, op.security ?? spec.security, schemes, secrets, name, result);
        const tag = Array.isArray(op.tags) && op.tags[0] ? [String(op.tags[0])] : [];
        result.requests.push({ folder: tag, doc });
      } catch (error) {
        result.skipped.push(`${name}: ${error.message}`);
      }
    }
  }

  const base = baseUrl(spec, swagger);
  if (base.note) result.skipped.push(base.note);
  result.environments.push({
    name: result.name,
    variables: [{ name: 'baseUrl', value: base.url }],
    secrets: [...secrets],
    secretValues: {},
  });
  return result;
}

function resolver(spec) {
  return function resolve(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || typeof value.$ref !== 'string') return value;
    const ref = value.$ref;
    if (!ref.startsWith('#/') || seen.has(ref)) return {};
    seen.add(ref);
    let target = spec;
    for (const part of ref.slice(2).split('/')) {
      target = target?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    return resolve(target ?? {}, seen);
  };
}

function mergeParams(pathParams, opParams, resolve) {
  const out = new Map();
  for (const p of [...(pathParams ?? []), ...(opParams ?? [])]) {
    const param = resolve(p);
    if (param?.name && param.in) out.set(`${param.in}:${param.name}`, param);
  }
  return [...out.values()];
}

function paramValue(p, resolve) {
  if (p.example !== undefined) return p.example;
  const examples = p.examples && Object.values(p.examples)[0];
  if (examples) {
    const ex = resolve(examples);
    if (ex?.value !== undefined) return ex.value;
  }
  const schema = resolve(p.schema) ?? p;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.example !== undefined) return schema.example;
  return '';
}

function sample(schema, resolve, depth = 0, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.$ref) {
    if (seen.has(schema.$ref) || depth > 8) return null;
    return sample(resolve(schema), resolve, depth + 1, new Set([...seen, schema.$ref]));
  }
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.allOf)) {
    const merged = {};
    for (const part of schema.allOf) {
      const v = sample(part, resolve, depth + 1, seen);
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(merged, v);
    }
    return merged;
  }
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[key]) && schema[key].length) return sample(schema[key][0], resolve, depth + 1, seen);
  }
  const type = Array.isArray(schema.type) ? schema.type.find(t => t !== 'null') : schema.type;
  if (type === 'object' || (!type && schema.properties)) {
    if (depth > 8) return {};
    const out = {};
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      if (prop?.readOnly) continue;
      out[key] = sample(prop, resolve, depth + 1, seen);
    }
    return out;
  }
  if (type === 'array') return depth > 8 ? [] : [sample(schema.items, resolve, depth + 1, seen)].filter(v => v !== null);
  if (type === 'integer' || type === 'number') return schema.minimum ?? 0;
  if (type === 'boolean') return false;
  if (type === 'string') {
    const formats = { 'date-time': '2026-01-01T00:00:00Z', date: '2026-01-01', email: 'user@example.com', uuid: '00000000-0000-0000-0000-000000000000', uri: 'https://example.com' };
    return formats[schema.format] ?? 'string';
  }
  return null;
}

function openApiBody(doc, op, resolve) {
  const body = resolve(op.requestBody);
  const content = body?.content;
  if (!content || typeof content !== 'object') return;
  const types = Object.keys(content);
  const json = types.find(t => /json/i.test(t));
  const form = types.find(t => /x-www-form-urlencoded/i.test(t));
  const multipart = types.find(t => /multipart\/form-data/i.test(t));
  const textType = types.find(t => /^text\/|xml/i.test(t));
  if (json) {
    const media = content[json];
    let value = media.example;
    if (value === undefined && media.examples) value = resolve(Object.values(media.examples)[0])?.value;
    if (value === undefined) value = sample(media.schema, resolve);
    doc.body = { type: 'json', text: typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2) };
    if (json !== 'application/json') doc.headers.push(row('Content-Type', json));
  } else if (form || multipart) {
    const media = content[form || multipart];
    const value = sample(media.schema, resolve) ?? {};
    doc.body = { type: 'form', form: Object.entries(value).map(([k, v]) => row(k, v)) };
  } else if (textType) {
    const media = content[textType];
    doc.body = { type: 'text', text: String(media.example ?? '') };
    doc.headers.push(row('Content-Type', textType));
  }
}

function swaggerBody(doc, op, params, spec, resolve) {
  const consumes = op.consumes ?? spec.consumes ?? [];
  const bodyParam = params.find(p => p.in === 'body');
  const formParams = params.filter(p => p.in === 'formData');
  if (bodyParam) {
    const value = bodyParam.schema?.example ?? sample(bodyParam.schema, resolve);
    doc.body = { type: 'json', text: JSON.stringify(value ?? {}, null, 2) };
    const type = consumes.find(t => /json/i.test(t));
    if (type && type !== 'application/json') doc.headers.push(row('Content-Type', type));
  } else if (formParams.length) {
    doc.body = { type: 'form', form: formParams.filter(p => p.type !== 'file').map(p => row(p.name, paramValue(p, resolve), !!p.required)) };
  }
}

function acceptType(op, spec, swagger) {
  if (swagger) {
    const produces = op.produces ?? spec.produces ?? [];
    return produces.find(t => /json/i.test(t)) ?? produces[0] ?? null;
  }
  for (const [code, response] of Object.entries(op.responses ?? {})) {
    if (!/^2/.test(code) || !response?.content) continue;
    const types = Object.keys(response.content);
    return types.find(t => /json/i.test(t)) ?? types[0] ?? null;
  }
  return null;
}

function applySecurity(doc, security, schemes, secrets, name, result) {
  if (!Array.isArray(security) || !security.length) return;
  const requirement = security.find(r => r && Object.keys(r).length);
  if (!requirement) return;
  const scheme = schemes[Object.keys(requirement)[0]];
  if (!scheme) return;
  const type = String(scheme.type ?? '').toLowerCase();
  const httpScheme = String(scheme.scheme ?? '').toLowerCase();
  if ((type === 'http' && httpScheme === 'bearer') || type === 'oauth2' || type === 'openidconnect') {
    doc.auth = { type: 'bearer', token: '{{token}}' };
    secrets.add('token');
  } else if ((type === 'http' && httpScheme === 'basic') || type === 'basic') {
    doc.auth = { type: 'basic', username: '{{username}}', password: '{{password}}' };
    secrets.add('username');
    secrets.add('password');
  } else if (type === 'apikey') {
    const target = scheme.in === 'query' ? doc.query : doc.headers;
    if (scheme.in === 'cookie') doc.headers.push(row('Cookie', `${scheme.name}={{apiKey}}`));
    else target.push(row(scheme.name || 'X-API-Key', '{{apiKey}}'));
    secrets.add('apiKey');
  } else {
    result.skipped.push(`${name}: ${scheme.type} security isn't supported, so it was left out.`);
  }
}

function baseUrl(spec, swagger) {
  if (swagger) {
    if (!spec.host) return { url: spec.basePath ?? '', note: 'The file has no host, so set baseUrl in the new environment.' };
    const scheme = spec.schemes?.includes('https') ? 'https' : spec.schemes?.[0] ?? 'https';
    return { url: `${scheme}://${spec.host}${spec.basePath && spec.basePath !== '/' ? spec.basePath : ''}` };
  }
  const server = spec.servers?.[0];
  if (!server?.url) return { url: '', note: 'The file has no servers, so set baseUrl in the new environment.' };
  let url = server.url.replace(/\{([^}]+)\}/g, (m, key) => server.variables?.[key]?.default ?? m).replace(/\/$/, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return { url, note: `The server URL "${url}" isn't a full address, so check baseUrl in the new environment.` };
  return { url };
}
