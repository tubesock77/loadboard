// Minimal CSV + XLSX readers (no dependencies). Returns an array of rows (arrays of strings).
const zlib = require('zlib');

function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

// --- tiny zip reader ---
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lelen;
    const data = buf.slice(start, start + csize);
    files[name] = () => (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    p += 46 + nlen + elen + clen;
  }
  return files;
}

function xmlDecode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}
function textOf(xml) {
  let out = '';
  xml.replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (_, t) => { out += t; });
  return xmlDecode(out);
}
function colIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/) || ['A'])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseXLSX(buf) {
  const files = unzip(buf);
  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    const xml = files['xl/sharedStrings.xml']();
    xml.replace(/<si>([\s\S]*?)<\/si>/g, (_, si) => { shared.push(textOf(si)); });
  }
  // first sheet in workbook order
  let sheetPath = 'xl/worksheets/sheet1.xml';
  try {
    const wb = files['xl/workbook.xml']();
    const rels = files['xl/_rels/workbook.xml.rels']();
    const first = wb.match(/<sheet\b[^>]*r:id="([^"]+)"/);
    if (first) {
      const rel = rels.match(new RegExp(`<Relationship\\b[^>]*Id="${first[1]}"[^>]*>`));
      const target = rel && rel[0].match(/Target="([^"]+)"/);
      if (target) sheetPath = target[1].startsWith('/') ? target[1].slice(1) : 'xl/' + target[1].replace(/^\.\//, '');
    }
  } catch (_) { /* fall back to sheet1 */ }
  if (!files[sheetPath]) sheetPath = Object.keys(files).find(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  if (!sheetPath) throw new Error('No worksheet found in file');
  const xml = files[sheetPath]();
  const rows = [];
  xml.replace(/<row\b[^>]*>([\s\S]*?)<\/row>/g, (_, rowXml) => {
    const row = [];
    rowXml.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (__, attrs, inner = '') => {
      const r = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
      const t = (attrs.match(/\bt="([^"]+)"/) || [])[1];
      const idx = r ? colIndex(r) : row.length;
      let v = '';
      const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
      if (t === 's' && vm) v = shared[+vm[1]] || '';
      else if (t === 'inlineStr') v = textOf(inner);
      else if (vm) v = xmlDecode(vm[1]);
      row[idx] = v;
    });
    for (let i = 0; i < row.length; i++) if (row[i] == null) row[i] = '';
    rows.push(row);
  });
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

function parseAny(buf) {
  if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b) return parseXLSX(buf);
  const text = buf.toString('utf8');
  if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('The link returned a web page, not a spreadsheet. Check the sharing settings (see the help text).');
  return parseCSV(text);
}

// Convert rows (first row = headers) into objects keyed by normalized header.
function rowsToObjects(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map(h => String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return rows.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => { if (h) o[h] = r[i] == null ? '' : String(r[i]).trim(); });
    return o;
  });
}

module.exports = { parseCSV, parseXLSX, parseAny, rowsToObjects };
