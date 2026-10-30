// Carrega uma "fonte" de dados com os valores REAIS (só dentro deste processo):
//   { arquivo, aba?, linha_cabecalho? }  -> .xlsx/.xlsm/.csv/.tsv/.txt
//   { conexao, sql }                    -> banco configurado em config.json
// Resultado: { label, columns: [...], rows: [{ n, cells: [...] }] }
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA_DIR, expandEnv, forbiddenReason } from './config.mjs';
import { openXlsx, colLetter } from './xlsx.mjs';
import { TOKEN_RE } from './vault.mjs';

// ---------- CSV ----------

function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  const utf8 = buf.toString('utf8');
  return utf8.includes('�') ? buf.toString('latin1') : utf8;
}

export function parseCsv(text, delimiter) {
  if (!delimiter) {
    const first = text.slice(0, text.search(/\r?\n/) >>> 0 || 2000);
    const count = (d) => first.split(d).length;
    delimiter = [';', ',', '\t', '|'].sort((a, b) => count(b) - count(a))[0];
  }
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push({ n: rowLine, cells: row });
      row = [];
      field = '';
      rowLine = ++line;
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push({ n: rowLine, cells: row });
  }
  return rows.map((r) => ({ n: r.n, cells: r.cells.map((c) => (c === '' ? null : c)) }));
}

// ---------- tabela com cabeçalho ----------

function withHeader(rawRows, headerRow, label) {
  const isEmpty = (r) => r.cells.every((c) => c === null || String(c).trim() === '');
  let hi = headerRow ? rawRows.findIndex((r) => r.n === Number(headerRow)) : rawRows.findIndex((r) => !isEmpty(r));
  if (hi < 0) return { label, columns: [], rows: [] };
  const width = Math.max(...rawRows.map((r) => r.cells.length));
  const seen = new Map();
  const columns = [];
  for (let i = 0; i < width; i++) {
    let name = String(rawRows[hi].cells[i] ?? '').trim() || `coluna_${colLetter(i)}`;
    const k = name.toLowerCase();
    if (seen.has(k)) {
      seen.set(k, seen.get(k) + 1);
      name = `${name}_${seen.get(k)}`;
    } else seen.set(k, 1);
    columns.push(name);
  }
  const rows = rawRows
    .slice(hi + 1)
    .filter((r) => !isEmpty(r))
    .map((r) => ({ n: r.n, cells: columns.map((_, i) => r.cells[i] ?? null) }));
  return { label, columns, rows };
}

// ---------- banco ----------

const requireDriver = createRequire(path.join(DATA_DIR, 'package.json'));

function loadDriver(pkg, driver) {
  try {
    return requireDriver(pkg);
  } catch {
    throw new Error(`driver "${driver}" não instalado. Rode no seu terminal: node "<plugin>/bin/cofre.mjs" instalar-driver ${driver}`);
  }
}

const WRITE_WORDS = /\b(insert|update|delete|merge|upsert|drop|alter|create|truncate|grant|revoke|exec|execute|call|into|attach|pragma|copy|lock)\b/i;

export function assertReadOnly(sql) {
  const bare = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .trim()
    .replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(bare)) throw new Error('só consultas de leitura (SELECT/WITH) são permitidas.');
  if (bare.includes(';')) throw new Error('envie um comando SQL por vez.');
  const m = bare.match(WRITE_WORDS);
  if (m) throw new Error(`a consulta contém "${m[0]}" — o cofre só executa leitura.`);
}

const placeholder = {
  sqlite: () => '?',
  mysql: () => '?',
  postgres: (i) => `$${i}`,
  sqlserver: (i) => `@p${i}`,
  oracle: (i) => `:${i}`,
};

// Troca tokens no SQL por parâmetros com o valor real (nunca concatena valor no texto).
export function bindTokens(sql, driver, vault) {
  for (const lit of sql.match(/'(?:[^']|'')*'/g) || []) {
    const inner = lit.slice(1, -1);
    if (new RegExp(TOKEN_RE.source).test(inner) && !new RegExp(`^${TOKEN_RE.source}$`).test(inner)) {
      throw new Error(`token dentro de texto do SQL (${lit}). Use o token sozinho: coluna = TOKEN ou coluna IN (TOKEN1, TOKEN2). LIKE com token não é possível.`);
    }
  }
  const params = [];
  const used = new Set();
  const re =new RegExp(`'(${TOKEN_RE.source})'|(${TOKEN_RE.source})`, 'g');
  const out = sql.replace(re, (m, quoted, _p1, _h1, bare) => {
    const tok = quoted || bare;
    const e = vault.lookup(tok);
    if (!e) throw new Error(`token ${tok} não existe no cofre.`);
    used.add(tok);
    params.push(e.k === 'numero' && typeof e.v !== 'number' && !Number.isNaN(Number(e.v)) ? Number(e.v) : e.v);
    return placeholder[driver](params.length);
  });
  return { sql: out, params, tokens: [...used] };
}

export function getConnection(cfg, name) {
  const conn = cfg.conexoes[name];
  if (!conn) {
    const names = Object.keys(cfg.conexoes);
    throw new Error(`conexão "${name}" não existe no config.json${names.length ? `. Disponíveis: ${names.join(', ')}` : ' (nenhuma configurada)'}.`);
  }
  return expandEnv(conn);
}

async function runQuery(conn, sql, params) {
  const driver = conn.driver;
  if (driver === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(conn.arquivo, { readOnly: true });
    try {
      const st = db.prepare(sql);
      const objs = st.all(...params);
      const columns = typeof st.columns === 'function' ? st.columns().map((c) => c.name) : Object.keys(objs[0] || {});
      return { columns, rows: objs.map((o) => columns.map((c) => o[c])) };
    } finally {
      db.close();
    }
  }
  if (driver === 'mysql') {
    const mysql = loadDriver('mysql2/promise', 'mysql');
    const c = await mysql.createConnection(conn.url || conn.opcoes);
    try {
      const [rows, fields] = await c.query({ sql, values: params, rowsAsArray: true });
      return { columns: fields.map((f) => f.name), rows };
    } finally {
      await c.end();
    }
  }
  if (driver === 'postgres') {
    const { Client } = loadDriver('pg', 'postgres');
    const opts = conn.url ? { connectionString: conn.url } : { ...conn.opcoes };
    opts.connectionTimeoutMillis ??= 20000;
    // "ca_arquivo": certificado da autoridade interna (.pem/.crt) para validar o SSL do servidor
    if (opts.ssl?.ca_arquivo) {
      const { ca_arquivo, ...ssl } = opts.ssl;
      opts.ssl = { ...ssl, ca: fs.readFileSync(ca_arquivo, 'utf8') };
    }
    const c = new Client(opts);
    await c.connect();
    try {
      const r = await c.query({ text: sql, values: params, rowMode: 'array' });
      return { columns: r.fields.map((f) => f.name), rows: r.rows };
    } finally {
      await c.end();
    }
  }
  if (driver === 'sqlserver') {
    const mssql = loadDriver('mssql', 'sqlserver');
    const pool = await new mssql.ConnectionPool(conn.url || conn.opcoes).connect();
    try {
      const req = pool.request();
      req.arrayRowMode = true;
      params.forEach((v, i) => req.input(`p${i + 1}`, v));
      const r = await req.query(sql);
      const cols = r.columns?.[0] || [];
      return { columns: cols.map((c) => c.name), rows: r.recordset || [] };
    } finally {
      await pool.close();
    }
  }
  if (driver === 'oracle') {
    const oracledb = loadDriver('oracledb', 'oracle');
    const c = await oracledb.getConnection(conn.opcoes || { connectString: conn.url });
    try {
      const r = await c.execute(sql, params, { outFormat: oracledb.OUT_FORMAT_ARRAY });
      return { columns: r.metaData.map((m) => m.name), rows: r.rows };
    } finally {
      await c.close();
    }
  }
  throw new Error(`driver "${driver}" não suportado (use sqlite, mysql, postgres, sqlserver ou oracle).`);
}

// ---------- entrada única ----------

export async function loadSource(src, cfg, vault) {
  if (!src || typeof src !== 'object') throw new Error('fonte inválida: informe { arquivo } ou { conexao, sql }.');
  if (src.conexao) {
    if (!src.sql) throw new Error('informe o sql da consulta.');
    const conn = getConnection(cfg, src.conexao);
    assertReadOnly(src.sql);
    const bound = bindTokens(src.sql, conn.driver, vault);
    const r = await runQuery(conn, bound.sql, bound.params);
    return {
      label: `${src.conexao}: consulta`,
      columns: r.columns.map(String),
      rows: r.rows.map((cells, i) => ({ n: i + 1, cells: Array.from(cells, (c) => c ?? null) })),
    };
  }
  if (!src.arquivo) throw new Error('informe arquivo ou conexao.');
  const file = path.resolve(src.arquivo);
  if (!fs.existsSync(file)) throw new Error(`arquivo não encontrado: ${file}`);
  const forbidden = forbiddenReason(file);
  if (forbidden) throw new Error(`acesso negado: ${forbidden}.`);
  const ext = path.extname(file).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm') {
    const wb = openXlsx(file);
    const sheet = wb.readSheet(src.aba);
    const t = withHeader(sheet.rows, src.linha_cabecalho, `${path.basename(file)} [${sheet.name}]`);
    t.sheets = wb.sheets;
    return t;
  }
  if (ext === '.xls' || ext === '.xlsb' || ext === '.ods') {
    throw new Error(`formato ${ext} não suportado. Abra no Excel e salve como .xlsx ou .csv.`);
  }
  const text = decodeText(fs.readFileSync(file));
  const raw = parseCsv(text, src.separador || (ext === '.tsv' ? '\t' : undefined));
  return withHeader(raw, src.linha_cabecalho, path.basename(file));
}
