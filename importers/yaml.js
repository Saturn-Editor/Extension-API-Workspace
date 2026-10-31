export function parseYaml(source) {
  const lines = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n');
  let i = 0;
  const anchors = {};

  function indentOf(line) {
    return line.length - line.trimStart().length;
  }

  function skip() {
    while (i < lines.length) {
      const t = lines[i].trim();
      if (t === '' || t.startsWith('#') || t === '---' || t.startsWith('%')) i++;
      else break;
    }
  }

  function isSeq(text) {
    return text === '-' || text.startsWith('- ');
  }

  function stripComment(text) {
    let quote = null;
    for (let k = 0; k < text.length; k++) {
      const c = text[k];
      if (quote) {
        if (c === '\\' && quote === '"') k++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        if (k === 0 || /[\s:[{,]/.test(text[k - 1])) quote = c;
      } else if (c === '#' && (k === 0 || /\s/.test(text[k - 1]))) {
        return text.slice(0, k).trimEnd();
      }
    }
    return text;
  }

  function splitKey(text) {
    const m = text.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"[\]{},&*!|>%@`-][^\n]*?|-[^\s][^\n]*?)\s*:(?:\s+(.*)|$)/);
    if (!m) return null;
    return { key: String(scalar(m[1])), rest: m[2] ?? '' };
  }

  function unquoteDouble(text) {
    try {
      return JSON.parse(text.replace(/\\([0abve ])/g, (m, c) => ({ 0: '\\u0000', a: '\\u0007', b: '\\b', v: '\\u000b', e: '\\u001b', ' ': ' ' })[c]));
    } catch {
      return text.slice(1, -1);
    }
  }

  function scalar(raw) {
    const s = raw.trim();
    if (s.startsWith('"') && s.endsWith('"') && s.length > 1) return unquoteDouble(s);
    if (s.startsWith("'") && s.endsWith("'") && s.length > 1) return s.slice(1, -1).replace(/''/g, "'");
    if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
    if (/^(true|True|TRUE)$/.test(s)) return true;
    if (/^(false|False|FALSE)$/.test(s)) return false;
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) && !/^0\d/.test(s)) return Number(s);
    if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
    if (s.startsWith('*')) return anchors[s.slice(1)] ?? null;
    return s;
  }

  function stripProps(text) {
    return text.replace(/^(?:&\S+|!\S*)\s*/, '').replace(/^(?:&\S+|!\S*)\s*/, '');
  }

  function balanced(text) {
    let depth = 0;
    let quote = null;
    for (let k = 0; k < text.length; k++) {
      const c = text[k];
      if (quote) {
        if (c === '\\' && quote === '"') k++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
    }
    return depth <= 0;
  }

  function flow(first) {
    let text = first;
    while (!balanced(text) && i < lines.length) text += ` ${stripComment(lines[i++].trim())}`;
    let k = 0;
    const ws = () => { while (k < text.length && /\s/.test(text[k])) k++; };
    function value() {
      ws();
      const c = text[k];
      if (c === '[') {
        k++;
        const out = [];
        ws();
        while (k < text.length && text[k] !== ']') {
          out.push(item());
          ws();
          if (text[k] === ',') k++;
          ws();
        }
        k++;
        return out;
      }
      if (c === '{') {
        k++;
        const out = {};
        ws();
        while (k < text.length && text[k] !== '}') {
          const key = atom(true);
          ws();
          let v = null;
          if (text[k] === ':') {
            k++;
            v = value();
          }
          out[String(key)] = v;
          ws();
          if (text[k] === ',') k++;
          ws();
        }
        k++;
        return out;
      }
      return atom(false);
    }
    function item() {
      const start = k;
      const v = value();
      ws();
      if (text[k] === ':' && !Array.isArray(v) && (v === null || typeof v !== 'object')) {
        k++;
        return { [String(v ?? text.slice(start, k - 1).trim())]: value() };
      }
      return v;
    }
    function atom(isKey) {
      ws();
      const c = text[k];
      if (c === '"' || c === "'") {
        const start = k++;
        while (k < text.length && text[k] !== c) {
          if (c === '"' && text[k] === '\\') k++;
          else if (c === "'" && text[k] === "'" && text[k + 1] === "'") k++;
          k++;
        }
        k++;
        return scalar(text.slice(start, k));
      }
      const start = k;
      while (k < text.length && !',]}'.includes(text[k]) && !(text[k] === ':' && (isKey || /[\s,\]}]/.test(text[k + 1] ?? ' ')))) k++;
      return scalar(stripProps(text.slice(start, k)));
    }
    return value();
  }

  function blockScalar(header, parentIndent) {
    const style = header[0];
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const explicit = header.match(/\d/);
    const raw = [];
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() !== '' && indentOf(line) <= parentIndent) break;
      raw.push(line);
      i++;
    }
    const firstText = raw.find(l => l.trim() !== '');
    const content = explicit ? parentIndent + Number(explicit[0]) : firstText ? indentOf(firstText) : parentIndent + 1;
    const body = raw.map(l => (l.trim() === '' ? '' : l.slice(content)));
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') {
      body.pop();
      trailing++;
    }
    let text;
    if (style === '|') text = body.join('\n');
    else {
      text = '';
      body.forEach((line, n) => {
        if (n === 0) text = line;
        else if (line === '' || line.startsWith(' ') || body[n - 1] === '' || body[n - 1].startsWith(' ')) text += `\n${line}`;
        else text += ` ${line}`;
      });
    }
    if (chomp === 'strip' || !body.length) return text;
    if (chomp === 'keep') return `${text}\n${'\n'.repeat(trailing)}`;
    return `${text}\n`;
  }

  function props(text) {
    let rest = text;
    let anchor = null;
    while (true) {
      const m = rest.match(/^(&|!)(\S*)\s*/);
      if (!m) break;
      if (m[1] === '&') anchor = m[2];
      rest = rest.slice(m[0].length);
    }
    return { anchor, rest };
  }

  function value(rest, ind) {
    const { anchor, rest: text } = props(stripComment(rest).trim());
    const result = valueOf(text, ind);
    if (anchor) anchors[anchor] = result;
    return result;
  }

  function valueOf(text, ind) {
    if (/^\*\S+$/.test(text)) return anchors[text.slice(1)] ?? null;
    if (text === '') {
      skip();
      if (i < lines.length && indentOf(lines[i]) === ind && isSeq(lines[i].slice(ind))) return seq(ind);
      return node(ind + 1);
    }
    if (/^[|>][-+0-9]*$/.test(text)) return blockScalar(text, ind);
    if (text.startsWith('[') || text.startsWith('{')) return flow(text);
    let plain = text;
    if (!/^["']/.test(text)) {
      while (i < lines.length) {
        const next = lines[i];
        const t = next.trim();
        if (t === '' || t.startsWith('#') || indentOf(next) <= ind || splitKey(t) || isSeq(t)) break;
        plain += ` ${stripComment(t)}`;
        i++;
      }
    } else if (!balancedQuote(text)) {
      while (i < lines.length && !balancedQuote(plain)) plain += ` ${lines[i++].trim()}`;
    }
    return scalar(plain);
  }

  function balancedQuote(text) {
    const q = text[0];
    if (text.length < 2) return false;
    if (q === "'") return /'$/.test(text) && (text.slice(1, -1).replace(/''/g, '').indexOf("'") === -1);
    return /(^|[^\\])(\\\\)*"$/.test(text.slice(1));
  }

  function map(ind) {
    const out = {};
    while (true) {
      skip();
      if (i >= lines.length) break;
      const li = indentOf(lines[i]);
      if (li !== ind) break;
      const text = lines[i].slice(li);
      if (isSeq(text)) break;
      const kv = splitKey(text);
      if (!kv) break;
      i++;
      if (kv.key === '<<') {
        const merged = value(kv.rest, ind);
        if (merged && typeof merged === 'object') Object.assign(out, merged);
        continue;
      }
      out[kv.key] = value(kv.rest, ind);
    }
    return out;
  }

  function seq(ind) {
    const out = [];
    while (true) {
      skip();
      if (i >= lines.length) break;
      const li = indentOf(lines[i]);
      const text = lines[i].slice(li);
      if (li !== ind || !isSeq(text)) break;
      const rest = text === '-' ? '' : text.slice(2);
      const trimmed = rest.trimStart();
      if (trimmed === '' || trimmed.startsWith('#')) {
        i++;
        out.push(node(ind + 1));
        continue;
      }
      const child = li + 2 + (rest.length - trimmed.length);
      lines[i] = ' '.repeat(child) + trimmed;
      out.push(node(child));
    }
    return out;
  }

  function node(minIndent) {
    skip();
    if (i >= lines.length) return null;
    const ind = indentOf(lines[i]);
    if (ind < minIndent) return null;
    const text = lines[i].slice(ind);
    if (isSeq(text)) return seq(ind);
    if (splitKey(text)) return map(ind);
    const { anchor, rest } = props(text);
    if (anchor && rest && !rest.startsWith('#') && (isSeq(rest) || splitKey(rest))) {
      lines[i] = ' '.repeat(ind) + rest;
      const result = node(ind);
      anchors[anchor] = result;
      return result;
    }
    i++;
    return value(text, ind - 1);
  }

  return node(0);
}
