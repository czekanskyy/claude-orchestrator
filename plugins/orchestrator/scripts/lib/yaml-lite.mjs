// Minimal, dependency-free parser for the YAML subset used by models.yaml.
// Supported: block maps/lists (space indentation), "- key: value" list items,
// flow collections ([a, b], {k: v}) incl. nesting, quoted/plain scalars,
// numbers, true/false, null/~, full-line and trailing comments.
// Not supported (by design): anchors, tags, multi-line/block scalars, tabs.

export class YamlError extends Error {
  constructor(message, lineNo) {
    super(lineNo ? `line ${lineNo}: ${message}` : message);
    this.lineNo = lineNo;
  }
}

function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue; }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i);
    }
  }
  return text;
}

const KEY_RE = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'[\]{},#][^:]*?)\s*:(?:\s+|$)/;

function unquote(s) {
  if (s.startsWith('"')) return JSON.parse(s);
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function plainScalar(s) {
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function parseFlow(src, lineNo) {
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const value = () => {
    ws();
    const c = src[i];
    if (c === '[') {
      i++; const arr = []; ws();
      if (src[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(value()); ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return arr; }
        throw new YamlError(`bad flow list near "${src.slice(i)}"`, lineNo);
      }
    }
    if (c === '{') {
      i++; const obj = {}; ws();
      if (src[i] === '}') { i++; return obj; }
      for (;;) {
        ws();
        const k = scalarToken(true);
        ws();
        if (src[i] !== ':') throw new YamlError(`expected ":" in flow map near "${src.slice(i)}"`, lineNo);
        i++;
        obj[k] = value(); ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; return obj; }
        throw new YamlError(`bad flow map near "${src.slice(i)}"`, lineNo);
      }
    }
    return scalarToken(false);
  };
  const scalarToken = (isKey) => {
    ws();
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (c === '"' && src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) {
          if (c === "'" && src[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      const tok = src.slice(i, j + 1);
      i = j + 1;
      return unquote(tok);
    }
    let j = i;
    const stop = isKey ? /[:,\]}]/ : /[,\]}]/;
    while (j < src.length && !stop.test(src[j])) j++;
    const tok = src.slice(i, j).trim();
    i = j;
    return isKey ? tok : plainScalar(tok);
  };
  const result = value();
  ws();
  if (i !== src.length) throw new YamlError(`trailing characters "${src.slice(i)}"`, lineNo);
  return result;
}

function parseScalar(text, lineNo) {
  const s = text.trim();
  if (s.startsWith('[') || s.startsWith('{')) return parseFlow(s, lineNo);
  if (s.startsWith('"') || s.startsWith("'")) {
    try { return unquote(s); } catch { throw new YamlError(`bad quoted string ${s}`, lineNo); }
  }
  if (s.startsWith('|') || s.startsWith('>')) throw new YamlError('block scalars are not supported', lineNo);
  if (s.startsWith('&') || s.startsWith('*') || s.startsWith('!')) throw new YamlError('anchors/tags are not supported', lineNo);
  return plainScalar(s);
}

const isListItem = (t) => t === '-' || t.startsWith('- ');

export function parseYaml(src) {
  const lines = [];
  String(src).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').forEach((raw, idx) => {
    if (/^\s*(#.*)?$/.test(raw)) return;
    const lead = raw.match(/^[ \t]*/)[0];
    if (lead.includes('\t')) throw new YamlError('tabs are not allowed for indentation', idx + 1);
    const text = stripComment(raw.slice(lead.length)).trimEnd();
    if (text === '') return;
    lines.push({ indent: lead.length, text, no: idx + 1 });
  });
  if (lines.length === 0) return null;
  let pos = 0;

  const parseNode = (indent) => (isListItem(lines[pos].text) ? parseList(indent) : parseMap(indent));

  const parseChild = (parentIndent, allowSameIndentList) => {
    if (pos >= lines.length) return null;
    const next = lines[pos];
    if (next.indent > parentIndent) return parseNode(next.indent);
    if (allowSameIndentList && next.indent === parentIndent && isListItem(next.text)) return parseList(parentIndent);
    return null;
  };

  function parseMap(indent) {
    const obj = {};
    while (pos < lines.length && lines[pos].indent === indent && !isListItem(lines[pos].text)) {
      const line = lines[pos];
      const m = line.text.match(KEY_RE);
      if (!m) throw new YamlError(`expected "key: value", got "${line.text}"`, line.no);
      const key = unquote(m[1].trim());
      if (Object.prototype.hasOwnProperty.call(obj, key)) throw new YamlError(`duplicate key "${key}"`, line.no);
      const rest = line.text.slice(m[0].length);
      pos++;
      obj[key] = rest.trim() === '' ? parseChild(indent, true) : parseScalar(rest, line.no);
    }
    if (pos < lines.length && lines[pos].indent > indent) {
      throw new YamlError(`unexpected indentation`, lines[pos].no);
    }
    return obj;
  }

  function parseList(indent) {
    const arr = [];
    while (pos < lines.length && lines[pos].indent === indent && isListItem(lines[pos].text)) {
      const line = lines[pos];
      const afterDash = line.text.slice(1);
      const rest = afterDash.trimStart();
      if (rest === '') {
        pos++;
        arr.push(parseChild(indent, false));
        continue;
      }
      if (KEY_RE.test(rest) && !rest.startsWith('[') && !rest.startsWith('{')) {
        const childIndent = indent + 1 + (afterDash.length - rest.length);
        lines[pos] = { indent: childIndent, text: rest, no: line.no };
        arr.push(parseMap(childIndent));
      } else {
        pos++;
        arr.push(parseScalar(rest, line.no));
      }
    }
    if (pos < lines.length && lines[pos].indent > indent) {
      throw new YamlError(`unexpected indentation`, lines[pos].no);
    }
    return arr;
  }

  const root = parseNode(lines[0].indent);
  if (pos < lines.length) throw new YamlError('unexpected content (check indentation)', lines[pos].no);
  return root;
}
