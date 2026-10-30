// Teste de ponta a ponta com dados FALSOS. Roda num cofre temporário:
//   node test/teste.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cofre-teste-'));
process.env.COFRE_HOME = path.join(TMP, 'cofre');
const { DatabaseSync } = await import('node:sqlite');
const ops = await import('../lib/ops.mjs');
const { PATHS } = await import('../lib/config.mjs');
const { bindTokens, assertReadOnly } = await import('../lib/sources.mjs');

// ---------- dados falsos ----------
const N = 10000;
const nomes = ['Acme Comércio Ltda', 'Beta Indústria SA', 'Gama Serviços', 'Delta Transportes', 'Ômega Foods'];
function cpf(i) {
  const d = String(100000000 + i * 7).padStart(9, '0').split('').map(Number);
  for (const n of [9, 10]) {
    let s = 0;
    for (let k = 0; k < n; k++) s += d[k] * (n + 1 - k);
    d.push(((s * 10) % 11) % 10);
  }
  return d.join('').replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}
const rows = Array.from({ length: N }, (_, i) => ({
  pedido: 1000 + i,
  data: new Date(Date.UTC(2026, i % 12, 1 + (i % 28))),
  cliente: nomes[i % nomes.length],
  cpf: cpf(i),
  email: `cliente${i}@exemplo.com.br`,
  valor: Math.round((100 + i * 3.17) * 100) / 100,
  status: i % 3 ? 'pago' : 'aberto',
}));
rows[5].email = null; // dado faltando na planilha

// xlsx mínimo (zip sem compressão)
function zip(files) {
  const parts = [];
  const central = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const nm = Buffer.from(name);
    const crc = zlib.crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, nm, data);
    central.push(c, nm);
    off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const shared = [];
const si = (s) => (shared.includes(s) ? shared.indexOf(s) : shared.push(s) - 1);
const L = 'ABCDEFG';
const head = ['Pedido', 'Data', 'Cliente', 'CPF', 'E-mail', 'Valor', 'Status'];
let sheet = `<row r="1">${head.map((h, i) => `<c r="${L[i]}1" t="s"><v>${si(h)}</v></c>`).join('')}</row>`;
rows.forEach((r, i) => {
  const n = i + 2;
  const serial = r.data.getTime() / 86400000 + 25569;
  const cells = [
    `<c r="A${n}"><v>${r.pedido}</v></c>`,
    `<c r="B${n}" s="1"><v>${serial}</v></c>`,
    `<c r="C${n}" t="s"><v>${si(r.cliente)}</v></c>`,
    `<c r="D${n}" t="s"><v>${si(r.cpf)}</v></c>`,
    r.email ? `<c r="E${n}" t="inlineStr"><is><t>${esc(r.email)}</t></is></c>` : '',
    `<c r="F${n}"><v>${r.valor}</v></c>`,
    `<c r="G${n}" t="s"><v>${si(r.status)}</v></c>`,
  ];
  sheet += `<row r="${n}">${cells.join('')}</row>`;
});
const xlsxFile = path.join(TMP, 'vendas.xlsx');
fs.writeFileSync(xlsxFile, zip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'xl/workbook.xml': '<workbook><sheets><sheet name="Vendas 2026" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/styles.xml': '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
  'xl/sharedStrings.xml': `<sst>${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`,
  'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
}));

// banco: faltam 3 pedidos, sobra 1, valor diferente em 1, cliente escrito diferente (maiúsculo/sem acento)
const dbFile = path.join(TMP, 'erp.db');
const db = new DatabaseSync(dbFile);
db.exec('CREATE TABLE vendas (id_pedido INTEGER, nome_cliente TEXT, cpf TEXT, email TEXT, valor REAL)');
const ins = db.prepare('INSERT INTO vendas VALUES (?, ?, ?, ?, ?)');
rows.forEach((r, i) => {
  if ([10, 20, 30].includes(i)) return;
  const nome = i % 2 ? r.cliente.toUpperCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '') : r.cliente;
  ins.run(r.pedido, nome, r.cpf.replace(/\D/g, ''), r.email ?? 'novo@exemplo.com', i === 40 ? r.valor + 1 : r.valor);
});
ins.run(99999, 'Fantasma SA', '000.000.001-91', 'x@y.com', 1);
db.close();

fs.mkdirSync(process.env.COFRE_HOME, { recursive: true });
fs.writeFileSync(PATHS.config, JSON.stringify({
  colunas_legiveis: ['status'],
  prefixo_por_coluna: { cliente: 'NAME', valor: 'BRL' },
  ferramentas_externas: { campos_legiveis: ['responsavel'], campos_mascarados: ['cliente', 'fornecedor'] },
  conexoes: { erp: { driver: 'sqlite', arquivo: dbFile } },
}));
fs.writeFileSync(PATHS.termos, 'Acme Comercio Ltda | NAME\nMaria\n');

const ctx = ops.context();
const segredo = /Acme|Beta Ind|cliente\d+@|\d{3}\.\d{3}\.\d{3}-\d{2}/;
let t0 = Date.now();

// ---------- ferramentas ----------
const est = await ops.estrutura(ctx, { fonte: { arquivo: xlsxFile } });
console.log(est, `\n(${Date.now() - t0} ms)\n`);
assert.match(est, /Linhas de dados: 10000/);
assert.doesNotMatch(est, segredo);

const lido = await ops.ler(ctx, { fonte: { arquivo: xlsxFile }, limite: 6 });
console.log(lido, '\n');
assert.doesNotMatch(lido, segredo);
assert.match(lido, /\tpago|\taberto/); // coluna legível
assert.match(lido, /2026-01-01/); // datas legíveis

t0 = Date.now();
const cmp = await ops.comparar(ctx, {
  esquerda: { arquivo: xlsxFile },
  direita: { conexao: 'erp', sql: 'SELECT * FROM vendas' },
  chave: { esquerda: 'Pedido', direita: 'id_pedido' },
  colunas: [{ esquerda: 'Cliente', direita: 'nome_cliente' }, 'CPF', { esquerda: 'E-mail', direita: 'email' }, 'Valor'],
  limite: 5,
});
console.log(cmp, `\n(${Date.now() - t0} ms)\n`);
assert.match(cmp, /Chaves só na esquerda: 3/);
assert.match(cmp, /Chaves só na direita: 1/);
assert.match(cmp, /E-mail\/email: 1/);
assert.match(cmp, /Valor: 1/);
assert.doesNotMatch(cmp, /Cliente\/nome_cliente:/); // maiúsculas/acentos não contam como diferença
assert.doesNotMatch(cmp, /CPF: \d/); // formato do CPF não conta
assert.doesNotMatch(cmp, segredo);

// mesmo valor -> mesmo token entre planilha e banco
const tokCliente = lido.split('\n')[2].split('\t')[3];
const doBanco = await ops.ler(ctx, { fonte: { conexao: 'erp', sql: 'SELECT nome_cliente FROM vendas WHERE id_pedido = 1000' } });
assert.ok(doBanco.includes(tokCliente), 'token do cliente deve ser igual na planilha e no banco');

// consulta com token: valor real vira parâmetro
const tokCpf = lido.split('\n')[2].split('\t')[4];
const b = bindTokens(`SELECT * FROM vendas WHERE cpf = ${tokCpf}`, 'sqlite', ctx.vault);
assert.equal(b.sql, 'SELECT * FROM vendas WHERE cpf = ?');
assert.equal(b.params[0], rows[0].cpf);
assert.throws(() => bindTokens(`SELECT * FROM vendas WHERE x LIKE '%${tokCpf}%'`, 'sqlite', ctx.vault));
assert.throws(() => assertReadOnly('DELETE FROM vendas'));
assert.throws(() => assertReadOnly('SELECT 1; DROP TABLE vendas'));
assertReadOnly("SELECT REPLACE(nome, 'a', 'b') FROM vendas -- update");

const exp = await ops.exportarMascarado(ctx, { fonte: { arquivo: xlsxFile }, saida: path.join(TMP, 'vendas.csv') });
const expFile = path.join(TMP, 'vendas.mascarado.csv');
assert.ok(fs.existsSync(expFile));
assert.doesNotMatch(fs.readFileSync(expFile, 'utf8'), segredo);
console.log(exp, '\n');

const relatorio = path.join(TMP, 'relatorio.md');
fs.writeFileSync(relatorio, `Cliente com problema: ${tokCliente}, CPF ${tokCpf}`);
const real = path.join(TMP, 'relatorio-real.md');
ops.desmascararArquivo(ctx, { entrada: relatorio, saida: real });
assert.equal(fs.readFileSync(real, 'utf8'), `Cliente com problema: ${rows[0].cliente}, CPF ${rows[0].cpf}`);

// ---------- hooks ----------
const hook = (file, payload) => {
  const r = spawnSync('node', [path.join(ROOT, 'hooks', file)], { input: JSON.stringify(payload), encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
};
const decision = (o) => o?.hookSpecificOutput?.permissionDecision;

assert.equal(decision(hook('guarda.mjs', { tool_name: 'Read', tool_input: { file_path: xlsxFile }, cwd: TMP })), 'deny');
assert.equal(decision(hook('guarda.mjs', { tool_name: 'Read', tool_input: { file_path: real }, cwd: TMP })), 'deny');
assert.equal(decision(hook('guarda.mjs', { tool_name: 'Read', tool_input: { file_path: PATHS.config }, cwd: TMP })), 'deny');
assert.equal(hook('guarda.mjs', { tool_name: 'Read', tool_input: { file_path: expFile }, cwd: TMP }), null);
assert.equal(hook('guarda.mjs', { tool_name: 'Read', tool_input: { file_path: relatorio }, cwd: TMP }), null);
assert.equal(decision(hook('guarda.mjs', { tool_name: 'PowerShell', tool_input: { command: 'Import-Csv .\\vendas.csv | select -first 5' }, cwd: TMP })), 'deny');
assert.equal(decision(hook('guarda.mjs', { tool_name: 'Bash', tool_input: { command: 'python -c "import pandas; pandas.read_excel(\'C:/x/vendas.xlsx\')"' }, cwd: TMP })), 'deny');
assert.equal(hook('guarda.mjs', { tool_name: 'Bash', tool_input: { command: 'python analise.py vendas.mascarado.csv' }, cwd: TMP }), null);
assert.equal(decision(hook('guarda.mjs', { tool_name: 'Bash', tool_input: { command: `type ${PATHS.cofre}` }, cwd: TMP })), 'deny');
const grep = hook('guarda.mjs', { tool_name: 'Grep', tool_input: { pattern: 'x', path: TMP }, cwd: TMP });
assert.match(grep.hookSpecificOutput.updatedInput.glob, /^!\*\.\{xlsx/);
assert.equal(decision(hook('guarda.mjs', { tool_name: 'Grep', tool_input: { pattern: 'x', glob: '*.csv' }, cwd: TMP })), 'deny');

const T = 'mcp__plugin_cofre-dados_cofre__';
assert.equal(decision(hook('confirmar.mjs', { tool_name: T + 'ler', tool_input: { fonte: { conexao: 'erp', sql: `SELECT * FROM v WHERE cpf = ${tokCpf}` } } })), 'ask');
assert.equal(hook('confirmar.mjs', { tool_name: T + 'ler', tool_input: { fonte: { conexao: 'erp', sql: 'SELECT * FROM v' } } }), null);
assert.equal(decision(hook('confirmar.mjs', { tool_name: T + 'desmascarar_arquivo', tool_input: { entrada: 'a', saida: 'b' } })), 'ask');

const jira = hook('mascarar-saida.mjs', {
  tool_name: 'mcp__jira__get_issue',
  tool_response: [{ type: 'text', text: JSON.stringify({ titulo: 'Erro no login', responsavel: 'Colega do Time', cliente: 'Acme Comercio Ltda', fornecedor: 'Zeta Peças', descricao:'CPF 123.456.789-09, contato maria@acme.com. Falou com a Maria.' }) }],
});
const issue = JSON.parse(jira.hookSpecificOutput.updatedToolOutput[0].text);
console.log('Jira mascarado:', issue);
assert.equal(issue.titulo, 'Erro no login');
assert.equal(issue.responsavel, 'Colega do Time');
assert.match(issue.cliente, /^NAME#[0-9a-f]{12}$/);
assert.match(issue.fornecedor, /^NAME#[0-9a-f]{12}$/); // campo mascarado mesmo sem estar nos termos
assert.match(issue.descricao, /^CPF CPF#[0-9a-f]{12}, contato EMAIL#[0-9a-f]{12}\. Falou com a NAME#[0-9a-f]{12}\.$/);
// "Acme Comercio Ltda" do Jira = "Acme Comércio Ltda" da planilha
assert.equal(issue.cliente.split('#')[1], tokCliente.split('#')[1]);

const bash = hook('mascarar-saida.mjs', { tool_name: 'Bash', tool_response: { stdout: 'total R$ 1.234,50 para joao@x.com', stderr: '', interrupted: false } });
console.log('Bash mascarado:', bash.hookSpecificOutput.updatedToolOutput);
assert.doesNotMatch(bash.hookSpecificOutput.updatedToolOutput.stdout, /1\.234|joao@/);
assert.equal(hook('mascarar-saida.mjs', { tool_name: 'Bash', tool_response: { stdout: 'nada sensivel aqui', stderr: '' } }), null);

const prompt = hook('filtro-mensagem.mjs', { prompt: 'o CPF 123.456.789-09 da Acme Comércio Ltda sumiu' });
assert.equal(prompt.decision, 'block');
console.log('\nMensagem barrada ->', prompt.reason.split('\n').pop());
assert.equal(hook('filtro-mensagem.mjs', { prompt: 'compare a planilha com o banco' }), null);

// ---------- servidor MCP ----------
const srv = spawnSync('node', [path.join(ROOT, 'server', 'index.mjs')], {
  input: [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ler', arguments: { fonte: { arquivo: xlsxFile }, limite: 2 } } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n',
  encoding: 'utf8',
  env: process.env,
});
const msgs = srv.stdout.trim().split('\n').map((l) => JSON.parse(l));
assert.equal(msgs.length, 3, srv.stderr);
assert.equal(msgs[1].result.tools.length, 7);
assert.doesNotMatch(msgs[2].result.content[0].text, segredo);

console.log('\nTODOS OS TESTES PASSARAM');
fs.rmSync(TMP, { recursive: true, force: true });
