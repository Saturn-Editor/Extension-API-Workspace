const PRELUDE = String.raw`
const logs = [];
const tests = [];
const pending = [];
const set = {};
const vars = Object.assign({}, input.variables);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fmt = v => {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};
const say = (...a) => { logs.push(a.map(fmt).join(' ')); };
const console = { log: say, info: say, warn: say, error: say, debug: say };
const errorText = e => (e && e.message) || String(e);

function getVar(name) {
  return own(vars, name) ? vars[name] : undefined;
}
function setVar(name, value) {
  const key = String(name);
  if (value === undefined || value === null) {
    delete vars[key];
    set[key] = null;
    return;
  }
  vars[key] = fmt(value);
  set[key] = vars[key];
}
const replaceIn = text => String(text).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, n) => (getVar(n) ?? m));
const store = {
  get: getVar,
  set: setVar,
  unset: name => setVar(name, null),
  has: name => getVar(name) !== undefined,
  toObject: () => Object.assign({}, vars),
  replaceIn,
};

const request = input.request ? {
  method: input.request.method,
  url: input.request.url,
  headers: input.request.headers.map(h => ({ name: h.name, value: h.value })),
  body: input.request.body,
} : null;
const findHeader = name => request.headers.find(h => h.name.toLowerCase() === String(name).toLowerCase());
const header = {
  get: name => findHeader(name)?.value,
  set: (name, value) => {
    const found = findHeader(name);
    if (found) found.value = fmt(value);
    else request.headers.push({ name: String(name), value: fmt(value) });
  },
  remove: name => {
    request.headers = request.headers.filter(h => h.name.toLowerCase() !== String(name).toLowerCase());
  },
};

const response = input.response;
const responseJson = () => JSON.parse(response.body);
const responseHeader = name => {
  const found = response.headers.find(([k]) => k.toLowerCase() === String(name).toLowerCase());
  return found ? found[1] : undefined;
};

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => deepEqual(a[k], b[k]));
}
const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function expect(actual, message) {
  const flags = { not: false, deep: false };
  const a = {};
  const check = (ok, text) => {
    if (!!ok === flags.not) throw new Error(message ? message : 'expected ' + fmt(actual) + ' ' + (flags.not ? 'not ' : '') + text);
    return a;
  };
  for (const word of ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'does', 'but', 'also']) {
    Object.defineProperty(a, word, { get: () => a });
  }
  Object.defineProperty(a, 'not', { get: () => { flags.not = !flags.not; return a; } });
  Object.defineProperty(a, 'deep', { get: () => { flags.deep = true; return a; } });
  const getters = {
    ok: () => check(!!actual, 'to be truthy'),
    true: () => check(actual === true, 'to be true'),
    false: () => check(actual === false, 'to be false'),
    null: () => check(actual === null, 'to be null'),
    undefined: () => check(actual === undefined, 'to be undefined'),
    NaN: () => check(Number.isNaN(actual), 'to be NaN'),
    exist: () => check(actual !== null && actual !== undefined, 'to exist'),
    empty: () => check(
      typeof actual === 'string' || Array.isArray(actual) ? actual.length === 0 : actual && typeof actual === 'object' ? Object.keys(actual).length === 0 : false,
      'to be empty'),
  };
  for (const [key, fn] of Object.entries(getters)) Object.defineProperty(a, key, { get: fn });
  const eq = v => check(flags.deep ? deepEqual(actual, v) : actual === v, 'to equal ' + fmt(v));
  a.equal = a.equals = a.eq = eq;
  a.eql = v => check(deepEqual(actual, v), 'to deeply equal ' + fmt(v));
  a.above = a.gt = a.greaterThan = n => check(actual > n, 'to be above ' + n);
  a.below = a.lt = a.lessThan = n => check(actual < n, 'to be below ' + n);
  a.least = a.gte = n => check(actual >= n, 'to be at least ' + n);
  a.most = a.lte = n => check(actual <= n, 'to be at most ' + n);
  a.within = (lo, hi) => check(actual >= lo && actual <= hi, 'to be within ' + lo + '..' + hi);
  a.a = a.an = t => check(typeOf(actual) === String(t).toLowerCase(), 'to be a ' + t);
  a.include = a.includes = a.contain = a.contains = v => check(
    typeof actual === 'string' ? actual.includes(v)
      : Array.isArray(actual) ? actual.some(x => (flags.deep ? deepEqual(x, v) : x === v))
        : actual && typeof actual === 'object' && v && typeof v === 'object' ? Object.entries(v).every(([k, x]) => deepEqual(actual[k], x))
          : false,
    'to include ' + fmt(v));
  a.property = (name, ...value) => {
    const has = actual !== null && actual !== undefined && own(Object(actual), name);
    if (value.length) return check(has && (flags.deep ? deepEqual(actual[name], value[0]) : actual[name] === value[0]), 'to have property ' + name + ' of ' + fmt(value[0]));
    return check(has, 'to have property ' + name);
  };
  a.keys = (...keys) => check(actual && keys.flat().every(k => own(actual, k)), 'to have keys ' + keys.flat().join(', '));
  a.lengthOf = n => check(actual !== null && actual !== undefined && actual.length === n, 'to have length ' + n);
  a.match = re => check(re.test(String(actual)), 'to match ' + re);
  a.oneOf = list => check(list.some(x => deepEqual(x, actual)), 'to be one of ' + fmt(list));
  a.status = code => check(actual && (actual.code ?? actual.status) === code, 'to have status ' + code);
  return a;
}
expect.fail = text => { throw new Error(text || 'Failed'); };

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pending.push(result.then(() => tests.push({ name: String(name), ok: true }), e => tests.push({ name: String(name), ok: false, error: errorText(e) })));
    } else {
      tests.push({ name: String(name), ok: true });
    }
  } catch (e) {
    tests.push({ name: String(name), ok: false, error: errorText(e) });
  }
}

const reqApi = request ? {
  getUrl: () => request.url,
  setUrl: v => { request.url = String(v); },
  getMethod: () => request.method,
  setMethod: v => { request.method = String(v).toUpperCase(); },
  getHeader: header.get,
  setHeader: header.set,
  deleteHeader: header.remove,
  getHeaders: () => Object.fromEntries(request.headers.map(h => [h.name, h.value])),
  getBody: () => request.body,
  setBody: v => { request.body = fmt(v); },
  getName: () => input.name,
} : {
  getName: () => input.name,
};

const resApi = response ? {
  status: response.status,
  statusText: response.statusText,
  headers: Object.fromEntries(response.headers),
  get body() {
    try { return responseJson(); } catch { return response.body; }
  },
  responseTime: response.time,
  getStatus: () => response.status,
  getHeader: responseHeader,
  getHeaders: () => Object.fromEntries(response.headers),
  getBody() { return this.body; },
  getResponseTime: () => response.time,
} : null;

const pmResponse = response ? {
  code: response.status,
  status: response.statusText,
  responseTime: response.time,
  headers: { get: responseHeader, has: name => responseHeader(name) !== undefined },
  text: () => response.body,
  json: responseJson,
} : null;
if (pmResponse) {
  pmResponse.to = {
    have: {
      status: code => expect(pmResponse).to.have.status(code),
      header: name => expect(responseHeader(name), 'expected header ' + name).to.exist,
      jsonBody: () => expect(() => responseJson()).to.exist,
    },
    be: {
      get ok() { return expect(response.status >= 200 && response.status < 300, 'expected a 2xx status, got ' + response.status).to.be.true; },
      get success() { return this.ok; },
    },
  };
}

const pm = {
  environment: store,
  variables: store,
  collectionVariables: store,
  globals: store,
  info: { requestName: input.name },
  request: request ? {
    get method() { return request.method; },
    set method(v) { request.method = String(v).toUpperCase(); },
    url: { toString: () => request.url, update: v => { request.url = String(v); } },
    headers: {
      add: h => header.set(h.key, h.value),
      upsert: h => header.set(h.key, h.value),
      remove: name => header.remove(name),
      get: name => header.get(name),
      has: name => header.get(name) !== undefined,
    },
    body: {
      get raw() { return request.body; },
      set raw(v) { request.body = fmt(v); },
      update: v => { request.body = typeof v === 'string' ? v : fmt(v && v.raw !== undefined ? v.raw : v); },
    },
  } : undefined,
  response: pmResponse,
  test,
  expect,
  sendRequest: () => { throw new Error('pm.sendRequest is not supported.'); },
};

const bru = {
  getEnvVar: getVar,
  setEnvVar: setVar,
  getVar,
  setVar,
  deleteVar: name => setVar(name, null),
  hasVar: name => getVar(name) !== undefined,
  interpolate: replaceIn,
  getRequestName: () => input.name,
};

const api = {
  variables: store,
  request: reqApi,
  response: resApi,
  test,
  expect,
  log: say,
};
const req = reqApi;
const res = resApi;
`;

export function sandboxCode(phase, script, input) {
  const json = JSON.stringify({ ...input, phase }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return [
    `const input = ${json};`,
    PRELUDE,
    'let failure = null;',
    'try {',
    '  await (async () => {',
    script,
    '  })();',
    '} catch (e) {',
    '  failure = errorText(e);',
    '}',
    'await Promise.all(pending);',
    'return JSON.parse(JSON.stringify({ request, set, tests, logs, error: failure }));',
  ].join('\n');
}
