// Regras de mascaramento: classifica cada valor, normaliza (para que "1.234,50" e 1234.5, ou
// "ACME COMÉRCIO" e "Acme Comercio", gerem o mesmo token) e troca por PREFIXO#hash.
import { normName } from './config.mjs';

export const PREFIX = {
  cpf: 'CPF',
  cnpj: 'CNPJ',
  email: 'EMAIL',
  telefone: 'TEL',
  numero: 'NUM',
  data: 'DATA',
  texto: 'TXT',
};

const digits = (s) => String(s).replace(/\D/g, '');
const stripZeros = (s) => s.replace(/^0+(?=\d)/, '');

export function validCPF(s) {
  const d = digits(s);
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  for (const n of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(d[i]) * (n + 1 - i);
    if (((sum * 10) % 11) % 10 !== Number(d[n])) return false;
  }
  return true;
}

export function validCNPJ(s) {
  const d = digits(s);
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  for (const n of [12, 13]) {
    const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(d[i]) * w[i];
    const r = sum % 11 < 2 ? 0 : 11 - (sum % 11);
    if (r !== Number(d[n])) return false;
  }
  return true;
}

export function normText(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function canonNum(n) {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

export function parseNumber(str, decimal = ',') {
  let t = String(str).trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (!/^[-+]?\d[\d.,]*$/.test(t) || /[.,]$/.test(t)) return null;
  const dots = (t.match(/\./g) || []).length;
  const commas = (t.match(/,/g) || []).length;
  if (dots && commas) {
    t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (commas) {
    if (/^[-+]?\d{1,3}(,\d{3})+$/.test(t) && (commas > 1 || decimal === '.')) t = t.replace(/,/g, '');
    else if (commas === 1) t = t.replace(',', '.');
    else return null;
  } else if (dots) {
    if (/^[-+]?\d{1,3}(\.\d{3})+$/.test(t) && (dots > 1 || decimal === ',')) t = t.replace(/\./g, '');
    else if (dots > 1) return null;
  }
  // Inteiros grandes (códigos, chaves) perderiam precisão como número: ficam como texto.
  if (digits(t).length > 15) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const pad = (n) => String(n).padStart(2, '0');

function isoDate(d) {
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return time === '00:00:00' ? day : `${day} ${time}`;
}

function parseDateStr(s) {
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
  return null;
}

// Classifica um valor de célula. norm = forma canônica usada no hash e nas comparações.
export function classify(v, decimal = ',') {
  if (v === null || v === undefined) return { kind: 'vazio', norm: '', display: '' };
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return { kind: 'texto', norm: 'INVALID DATE', display: 'Invalid Date' };
    const iso = isoDate(v);
    return { kind: 'data', norm: iso, display: iso, raw: iso };
  }
  if (typeof v === 'bigint') v = v.toString();
  if (typeof v === 'boolean') v = v ? 'VERDADEIRO' : 'FALSO';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { kind: 'texto', norm: String(v), display: String(v), raw: String(v) };
    return { kind: 'numero', norm: canonNum(v), display: String(v), raw: v };
  }
  if (Buffer.isBuffer(v)) v = v.toString('hex');
  if (typeof v === 'object') v = JSON.stringify(v);

  const s = String(v).trim();
  if (!s) return { kind: 'vazio', norm: '', display: '' };

  if (/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(s) || (/^\d{11}$/.test(s) && validCPF(s)))
    return { kind: 'cpf', norm: stripZeros(digits(s)), display: s, raw: s };
  if (/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/.test(s) || (/^\d{14}$/.test(s) && validCNPJ(s)))
    return { kind: 'cnpj', norm: stripZeros(digits(s)), display: s, raw: s };
  if (/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(s)) return { kind: 'email', norm: s.toLowerCase(), display: s, raw: s };
  if (/^(?:\+55\s?)?\(?\d{2}\)?\s?9?\d{4}-?\d{4}$/.test(s) && /[()\-\s+]/.test(s))
    return { kind: 'telefone', norm: stripZeros(digits(s)), display: s, raw: s };

  const n = parseNumber(s, decimal);
  if (n !== null) return { kind: 'numero', norm: canonNum(n), display: s, raw: n };

  const d = parseDateStr(s);
  if (d && !Number.isNaN(d.getTime())) {
    const iso = isoDate(d);
    return { kind: 'data', norm: iso, display: s, raw: s };
  }
  return { kind: 'texto', norm: normText(s), display: s, raw: s };
}

// ---------- mascaramento de texto livre (CPF, CNPJ, e-mail, telefone, R$, termos) ----------

const ACCENTS = { a: 'aáàâãä', e: 'eéèêë', i: 'iíìîï', o: 'oóòôõö', u: 'uúùûü', c: 'cç', n: 'nñ' };

function termPattern(term) {
  return normText(term)
    .toLowerCase()
    .split('')
    .map((ch) => {
      if (ch === ' ') return '\\s+';
      if (ACCENTS[ch]) return `[${ACCENTS[ch]}]`;
      return ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
    })
    .join('');
}

const B = '(?<![\\w#@.])'; // não começa colado em palavra/token
const E = '(?![\\w@])';

const DETECTORS = [
  { kind: 'cnpj', re: new RegExp(`${B}\\d{2}\\.\\d{3}\\.\\d{3}\\/\\d{4}-\\d{2}${E}|${B}\\d{14}${E}`, 'g'), ok: (m) => m.includes('/') || validCNPJ(m) },
  { kind: 'cpf', re: new RegExp(`${B}\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}${E}|${B}\\d{11}${E}`, 'g'), ok: (m) => m.includes('-') || validCPF(m) },
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'telefone', re: new RegExp(`(?:\\+55\\s?)?\\(\\d{2}\\)\\s?9?\\d{4}-?\\d{4}${E}|${B}\\d{2}\\s9?\\d{4}-\\d{4}${E}`, 'g') },
  { kind: 'numero', prefix: 'BRL', re: /R\$\s?-?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?(?![\d,])|R\$\s?-?\d+(?:,\d{1,2})?(?![\d,])/gi },
];

export function makeTextMasker(vault, terms = [], decimal = ',') {
  const sorted = [...terms].sort((a, b) => b.term.length - a.term.length);
  const termRe = sorted.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${sorted.map((t) => `(${termPattern(t.term)})`).join('|')})(?![\\p{L}\\p{N}])`, 'giu')
    : null;

  return function maskText(input) {
    let s = String(input);
    for (const det of DETECTORS) {
      s = s.replace(det.re, (m) => {
        if (det.ok && !det.ok(m)) return m;
        const c = classify(m, decimal);
        const kind = det.kind === 'numero' ? 'numero' : c.kind === det.kind ? c.kind : det.kind;
        const norm = kind === 'numero' ? c.norm : c.kind === det.kind ? c.norm : normText(m);
        return vault.token(norm, c.raw ?? m, kind, det.prefix || PREFIX[kind]);
      });
    }
    if (termRe) {
      s = s.replace(termRe, (m, ...groups) => {
        const idx = groups.findIndex((g, i) => i < sorted.length && g !== undefined);
        const prefix = sorted[idx]?.prefix || 'NAME';
        return vault.token(normText(m), m, 'texto', prefix);
      });
    }
    return s;
  };
}

// ---------- mascaramento de células (planilhas e resultados de consulta) ----------

export function makeCellMasker(vault, cfg, terms) {
  const maskText = makeTextMasker(vault, terms, cfg.separador_decimal);
  const legiveis = new Set(cfg.colunas_legiveis.map(normName));
  const prefixos = new Map(Object.entries(cfg.prefixo_por_coluna).map(([k, v]) => [normName(k), String(v).toUpperCase()]));
  const tiposLegiveis = new Set(cfg.tipos_legiveis);

  const maskCell = (value, column) => {
    const c = classify(value, cfg.separador_decimal);
    if (c.kind === 'vazio') return '';
    const col = normName(column);
    if (legiveis.has(col) || tiposLegiveis.has(c.kind)) return maskText(c.display);
    return vault.token(c.norm, c.raw ?? c.display, c.kind, prefixos.get(col) || PREFIX[c.kind]);
  };
  return { maskCell, maskText };
}

export const normCell = (v, decimal) => classify(v, decimal).norm;
