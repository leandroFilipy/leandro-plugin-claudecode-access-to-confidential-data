// Leitor mínimo de .xlsx/.xlsm sem dependências: abre o zip, lê sharedStrings, estilos (para
// reconhecer datas) e as abas. Fórmulas entram com o último valor calculado salvo pelo Excel.
import fs from 'node:fs';
import zlib from 'node:zlib';

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('arquivo não é um .xlsx válido (zip não encontrado). Arquivos .xls antigos: salve como .xlsx ou .csv.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.set(name, { method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return (name) => {
    const f = files.get(name);
    if (!f) return null;
    const start = f.local + 30 + buf.readUInt16LE(f.local + 26) + buf.readUInt16LE(f.local + 28);
    const data = buf.subarray(start, start + f.csize);
    return (f.method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
  };
}

const decode = (s) =>
  s
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, (_, e) =>
      e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'" : e === 'amp' ? '&'
        : e[1] === 'x' ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(parseInt(e.slice(1), 10)));

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decode(m[1]) : undefined;
};

const textOf = (xml) => {
  let out = '';
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) out += decode(m[1] ?? '');
  return out;
};

function colIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function colLetter(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function excelDate(serial, date1904) {
  const ms = Math.round((serial + (date1904 ? 1462 : 0) - 25569) * 86400000);
  return new Date(ms);
}

export function openXlsx(file) {
  const read = unzip(fs.readFileSync(file));
  const wb = read('xl/workbook.xml');
  if (!wb) throw new Error('xl/workbook.xml não encontrado — o arquivo é mesmo um .xlsx?');
  const date1904 = /date1904="(1|true)"/.test(wb);

  const rels = new Map();
  for (const m of (read('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*>/g)) {
    rels.set(attr(m[0], 'Id'), attr(m[0], 'Target'));
  }
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const target = rels.get(attr(m[0], 'r:id')) || '';
    const p = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    sheets.push({ name: attr(m[0], 'name'), path: p });
  }

  const shared = [];
  for (const m of (read('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));

  const styles = read('xl/styles.xml') || '';
  const customDate = new Set();
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) {
    const code = (attr(m[0], 'formatCode') || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    if (/[dmyhs]/i.test(code) && !/^[#0.,%\s]*$/.test(code)) customDate.add(Number(attr(m[0], 'numFmtId')));
  }
  const xfDate = [];
  const cellXfs = styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (cellXfs) {
    for (const m of cellXfs[1].matchAll(/<xf\b[^>]*>/g)) {
      const id = Number(attr(m[0], 'numFmtId') || 0);
      xfDate.push(BUILTIN_DATE.has(id) || customDate.has(id));
    }
  }

  function readSheet(name) {
    const sh = name === undefined ? sheets[0] : sheets.find((s) => s.name === name) || sheets[Number(name)];
    if (!sh) throw new Error(`aba "${name}" não existe. Abas: ${sheets.map((s) => s.name).join(', ')}`);
    const xml = read(sh.path);
    if (!xml) throw new Error(`não consegui abrir a aba "${sh.name}"`);
    const rows = []; // [{ n: número da linha no Excel, cells: [] }]
    for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
      const rowNum = Number(attr(' ' + (rm[1] || rm[3] || ''), 'r')) || rows.length + 1;
      const cells = [];
      let next = 0;
      for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = ' ' + cm[1];
        const ref = attr(a, 'r');
        const idx = ref ? colIndex(ref) : next;
        next = idx + 1;
        const t = attr(a, 't');
        const body = cm[2] || '';
        const vm = body.match(/<v>([\s\S]*?)<\/v>/);
        const v = vm ? decode(vm[1]) : undefined;
        let val = null;
        if (t === 's') val = v !== undefined ? shared[Number(v)] ?? null : null;
        else if (t === 'inlineStr') val = textOf(body);
        else if (t === 'str' || t === 'e') val = v ?? null;
        else if (t === 'b') val = v === '1';
        else if (t === 'd') val = v ? new Date(v) : null;
        else if (v !== undefined && v !== '') {
          const num = Number(v);
          val = xfDate[Number(attr(a, 's') || 0)] ? excelDate(num, date1904) : num;
        }
        cells[idx] = val;
      }
      for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = null;
      rows.push({ n: rowNum, cells });
    }
    return { name: sh.name, rows };
  }

  return { sheets: sheets.map((s) => s.name), readSheet };
}
