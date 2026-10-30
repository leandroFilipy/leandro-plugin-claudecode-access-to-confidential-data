// Operações expostas ao Claude. Os valores reais só existem dentro destas funções;
// tudo que sai daqui (texto de resposta e arquivos gerados) já está mascarado,
// exceto desmascarar_arquivo, que grava para VOCÊ um arquivo que o Claude não pode ler.
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, DATA_DIR, loadConfig, loadTerms, normName } from './config.mjs';
import { Vault, TOKEN_RE } from './vault.mjs';
import { makeCellMasker, classify } from './mask.mjs';
import { loadSource } from './sources.mjs';

let sharedVault;

// Config e termos são relidos a cada chamada (você pode editar sem reiniciar); o cofre é reaproveitado.
export function context() {
  const cfg = loadConfig();
  const terms = loadTerms();
  const vault = (sharedVault ??= new Vault());
  return { cfg, terms, vault, ...makeCellMasker(vault, cfg, terms) };
}

const tsv = (cells) => cells.map((c) => String(c ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t');

function pickColumns(table, wanted) {
  if (!wanted?.length) return table.columns.map((_, i) => i);
  return wanted.map((w) => {
    const i = table.columns.findIndex((c) => normName(c) === normName(w));
    if (i < 0) throw new Error(`coluna "${w}" não existe. Colunas: ${table.columns.join(', ')}`);
    return i;
  });
}

export async function estrutura(ctx, { fonte }) {
  const t = await loadSource(fonte, ctx.cfg, ctx.vault);
  const lines = [`Fonte: ${t.label}`];
  if (t.sheets) lines.push(`Abas: ${t.sheets.join(' | ')}`);
  lines.push(`Linhas de dados: ${t.rows.length}`, '', tsv(['coluna', 'tipo', 'vazios', 'distintos', 'exemplos (mascarados)']));
  t.columns.forEach((col, i) => {
    const kinds = new Map();
    const distinct = new Set();
    let empty = 0;
    const samples = [];
    for (const r of t.rows) {
      const c = classify(r.cells[i], ctx.cfg.separador_decimal);
      if (c.kind === 'vazio') {
        empty++;
        continue;
      }
      kinds.set(c.kind, (kinds.get(c.kind) || 0) + 1);
      if (!distinct.has(c.norm) && samples.length < 3) samples.push(ctx.maskCell(r.cells[i], col));
      distinct.add(c.norm);
    }
    const kind = [...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => (kinds.size > 1 ? `${k}(${n})` : k)).join('+') || 'vazio';
    lines.push(tsv([col, kind, empty, distinct.size, samples.join(' ; ')]));
  });
  const fullRows = new Map();
  for (const r of t.rows) {
    const k = r.cells.map((c) => classify(c, ctx.cfg.separador_decimal).norm).join('\u0001');
    fullRows.set(k, (fullRows.get(k) || 0) + 1);
  }
  const dup = [...fullRows.values()].filter((n) => n > 1).reduce((a, n) => a + n - 1, 0);
  lines.push('', `Linhas totalmente duplicadas: ${dup}`);
  return lines.join('\n');
}

export async function ler(ctx, { fonte, inicio = 1, limite = 50, colunas }) {
  const t = await loadSource(fonte, ctx.cfg, ctx.vault);
  const idx = pickColumns(t, colunas);
  const from = Math.max(1, Number(inicio)) - 1;
  const slice = t.rows.slice(from, from + Math.min(Number(limite) || 50, 2000));
  const out = [
    `Fonte: ${t.label} — linhas ${from + 1} a ${from + slice.length} de ${t.rows.length}`,
    tsv(['#linha', ...idx.map((i) => t.columns[i])]),
    ...slice.map((r) => tsv([r.n, ...idx.map((i) => ctx.maskCell(r.cells[i], t.columns[i]))])),
  ];
  return out.join('\n');
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function exportarMascarado(ctx, { fonte, saida }) {
  const t = await loadSource(fonte, ctx.cfg, ctx.vault);
  let out = path.resolve(saida);
  if (!/\.mascarado\./i.test(path.basename(out))) {
    const ext = path.extname(out) || '.csv';
    out = path.join(path.dirname(out), path.basename(out, path.extname(out)) + '.mascarado' + ext);
  }
  const lines = [['linha', ...t.columns].map(csvCell).join(',')];
  for (const r of t.rows) lines.push([r.n, ...t.columns.map((c, i) => ctx.maskCell(r.cells[i], c))].map(csvCell).join(','));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, '﻿' + lines.join('\r\n'), 'utf8');
  return `Exportado ${t.rows.length} linhas mascaradas para ${out}\nEsse arquivo pode ser lido e processado livremente (só contém tokens).`;
}

function resolvePairs(spec, left, right, label) {
  if (!spec) return null;
  let list = [spec];
  if (Array.isArray(spec)) list = spec;
  else if (Array.isArray(spec.esquerda)) list = spec.esquerda.map((e, i) => ({ esquerda: e, direita: spec.direita?.[i] ?? e }));
  return list.map((p) => {
    const l = typeof p === 'string' ? p : p.esquerda;
    const r = typeof p === 'string' ? p : p.direita;
    const li = left.columns.findIndex((c) => normName(c) === normName(l));
    const ri = right.columns.findIndex((c) => normName(c) === normName(r));
    if (li < 0) throw new Error(`${label}: coluna "${l}" não existe na esquerda (${left.columns.join(', ')})`);
    if (ri < 0) throw new Error(`${label}: coluna "${r}" não existe na direita (${right.columns.join(', ')})`);
    return { l: li, r: ri, nome: l === r ? l : `${l}/${r}` };
  });
}

export async function comparar(ctx, { esquerda, direita, chave, colunas, limite = 30, salvar_em }) {
  const L = await loadSource(esquerda, ctx.cfg, ctx.vault);
  const R = await loadSource(direita, ctx.cfg, ctx.vault);
  const keys = resolvePairs(typeof chave === 'string' ? [chave] : chave, L, R, 'chave');
  if (!keys?.length) throw new Error('informe a chave (coluna que identifica a linha nos dois lados).');
  let cols = resolvePairs(colunas, L, R, 'colunas');
  if (!cols) {
    const keyL = new Set(keys.map((k) => k.l));
    cols = L.columns
      .map((c, li) => ({ l: li, r: R.columns.findIndex((x) => normName(x) === normName(c)), nome: c }))
      .filter((p) => p.r >= 0 && !keyL.has(p.l));
  }
  const dec = ctx.cfg.separador_decimal;
  const norm = (v) => classify(v, dec).norm;

  const index = (T, side) => {
    const map = new Map();
    let semChave = 0;
    for (const row of T.rows) {
      const parts = keys.map((k) => norm(row.cells[side === 'l' ? k.l : k.r]));
      if (parts.every((p) => p === '')) {
        semChave++;
        continue;
      }
      const k = parts.join('\u0001');
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(row);
    }
    return { map, semChave };
  };
  const li = index(L, 'l');
  const ri = index(R, 'r');

  const keyText = (row, side) => keys.map((k) => ctx.maskCell(row.cells[side === 'l' ? k.l : k.r], side === 'l' ? L.columns[k.l] : R.columns[k.r])).join(' + ');
  const soEsquerda = [];
  const soDireita = [];
  const diferencas = [];
  const porColuna = new Map(cols.map((c) => [c.nome, 0]));
  let iguais = 0;

  for (const [k, rows] of li.map) {
    const other = ri.map.get(k);
    if (!other) {
      soEsquerda.push(...rows.map((r) => ({ linha: r.n, chave: keyText(r, 'l') })));
      continue;
    }
    const a = rows[0];
    const b = other[0];
    let rowDiff = false;
    for (const c of cols) {
      const va = norm(a.cells[c.l]);
      const vb = norm(b.cells[c.r]);
      if (va === vb) continue;
      rowDiff = true;
      porColuna.set(c.nome, porColuna.get(c.nome) + 1);
      diferencas.push({
        chave: keyText(a, 'l'),
        linha_esquerda: a.n,
        linha_direita: b.n,
        coluna: c.nome,
        esquerda: va === '' ? '(vazio)' : ctx.maskCell(a.cells[c.l], L.columns[c.l]),
        direita: vb === '' ? '(vazio)' : ctx.maskCell(b.cells[c.r], R.columns[c.r]),
      });
    }
    if (!rowDiff) iguais++;
  }
  for (const [k, rows] of ri.map) if (!li.map.has(k)) soDireita.push(...rows.map((r) => ({ linha: r.n, chave: keyText(r, 'r') })));

  const dups = (m) => [...m.values()].filter((r) => r.length > 1).length;
  const n = Math.max(0, Number(limite) || 30);
  const lines = [
    `Esquerda: ${L.label} — ${L.rows.length} linhas | Direita: ${R.label} — ${R.rows.length} linhas`,
    `Chave: ${keys.map((k) => k.nome).join(' + ')} | Colunas comparadas: ${cols.map((c) => c.nome).join(', ') || '(nenhuma)'}`,
    `Comparação ignora maiúsculas/acentos/espaços e formato de número/data (1.234,50 = 1234.5).`,
    '',
    `Chaves só na esquerda: ${soEsquerda.length}`,
    `Chaves só na direita: ${soDireita.length}`,
    `Chaves nos dois lados e iguais: ${iguais}`,
    `Chaves nos dois lados com diferença: ${new Set(diferencas.map((d) => d.chave)).size} (${diferencas.length} células)`,
    ...cols.filter((c) => porColuna.get(c.nome)).map((c) => `   - ${c.nome}: ${porColuna.get(c.nome)}`),
    `Chaves duplicadas: esquerda ${dups(li.map)}, direita ${dups(ri.map)} | Linhas sem chave: esquerda ${li.semChave}, direita ${ri.semChave}`,
  ];
  const section = (title, items, cols2) => {
    if (!items.length) return;
    lines.push('', `${title} (mostrando ${Math.min(n, items.length)} de ${items.length})`, tsv(cols2));
    for (const it of items.slice(0, n)) lines.push(tsv(cols2.map((c) => it[c])));
  };
  section('Só na esquerda', soEsquerda, ['linha', 'chave']);
  section('Só na direita', soDireita, ['linha', 'chave']);
  section('Diferenças', diferencas, ['chave', 'coluna', 'esquerda', 'direita', 'linha_esquerda', 'linha_direita']);

  if (salvar_em) {
    let out = path.resolve(salvar_em);
    if (!/\.mascarado\./i.test(path.basename(out))) out = out.replace(/(\.[^.\\/]+)?$/, '.mascarado.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ resumo: lines.slice(0, 10), so_esquerda: soEsquerda, so_direita: soDireita, diferencas }, null, 2), 'utf8');
    lines.push('', `Relatório completo (mascarado) salvo em ${out}`);
  }
  return lines.join('\n');
}

export function listarConexoes(ctx) {
  const entries = Object.entries(ctx.cfg.conexoes);
  if (!entries.length) return `Nenhuma conexão configurada. O usuário deve adicionar em ${PATHS.config} (campo "conexoes").`;
  return entries.map(([nome, c]) => `${nome}\t${c.driver}`).join('\n');
}

function registerRevealed(file) {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(PATHS.revelados, 'utf8'));
  } catch {}
  if (!list.includes(file)) list.push(file);
  fs.writeFileSync(PATHS.revelados, JSON.stringify(list, null, 2));
}

export function desmascararArquivo(ctx, { entrada, saida }) {
  const src = path.resolve(entrada);
  const out = path.resolve(saida);
  if (src === out) throw new Error('a saída precisa ser outro arquivo.');
  const text = fs.readFileSync(src, 'utf8');
  let trocados = 0;
  const desconhecidos = new Set();
  const result = text.replace(TOKEN_RE, (m) => {
    const e = ctx.vault.lookup(m);
    if (!e) {
      desconhecidos.add(m);
      return m;
    }
    trocados++;
    return String(e.v);
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, result, 'utf8');
  registerRevealed(out);
  return [
    `Arquivo com valores reais gravado em ${out} (${trocados} tokens trocados).`,
    `Esse arquivo é só para o usuário: o Claude está bloqueado de lê-lo.`,
    desconhecidos.size ? `Tokens não encontrados no cofre: ${desconhecidos.size}` : '',
  ].filter(Boolean).join('\n');
}

export function status(ctx) {
  return [
    `Pasta do cofre: ${DATA_DIR}`,
    `Valores no cofre: ${ctx.vault.size()}`,
    `Termos cadastrados: ${ctx.terms.length}`,
    `Colunas legíveis: ${ctx.cfg.colunas_legiveis.join(', ') || '(nenhuma)'}`,
    `Tipos legíveis: ${ctx.cfg.tipos_legiveis.join(', ') || '(nenhum)'}`,
    `Conexões: ${Object.keys(ctx.cfg.conexoes).join(', ') || '(nenhuma)'}`,
  ].join('\n');
}
