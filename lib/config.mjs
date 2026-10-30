// Configuração e caminhos do cofre. Tudo fica fora da pasta do plugin, em ~/.cofre-dados
// (ou COFRE_HOME), e essa pasta é bloqueada para leitura pelo Claude (ver hooks/guarda.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.COFRE_HOME || path.join(os.homedir(), '.cofre-dados'));

export const PATHS = {
  config: path.join(DATA_DIR, 'config.json'),
  termos: path.join(DATA_DIR, 'termos.txt'),
  cofre: path.join(DATA_DIR, 'cofre.log'),
  chave: path.join(DATA_DIR, 'chave.key'),
  revelados: path.join(DATA_DIR, 'revelados.json'),
};

export const DEFAULTS = {
  // Colunas que ficam legíveis (nome da coluna, sem diferenciar maiúsculas/acentos).
  // Mesmo legíveis, ainda passam pelo filtro de CPF/CNPJ/e-mail/telefone/termos.
  colunas_legiveis: [],
  // Prefixo do token por coluna, ex.: {"cliente": "NAME", "valor": "BRL"}. Só muda a etiqueta;
  // o código depois do # depende apenas do valor, então tokens continuam cruzando entre fontes.
  prefixo_por_coluna: {},
  // Tipos de valor que ficam legíveis em qualquer coluna: "data", "numero", "texto", "cpf", "cnpj", "email", "telefone".
  tipos_legiveis: ['data'],
  // Separador decimal usado quando o número for ambíguo (ex.: "1.234").
  separador_decimal: ',',
  // Arquivos com essas extensões não podem ser lidos direto pelo Claude (só via ferramentas do cofre).
  extensoes_protegidas: ['xlsx', 'xlsm', 'xls', 'xlsb', 'csv', 'tsv', 'ods'],
  // Pastas inteiras bloqueadas para leitura direta.
  pastas_protegidas: [],
  // Saída de outras ferramentas MCP (Jira, Notion, CRM, API interna...).
  ferramentas_externas: {
    campos_legiveis: [],      // ficam como estão
    campos_mascarados: [],    // viram token inteiro (ex.: "cliente")
    ignorar_ferramentas: [],  // regex de nomes de ferramenta que não passam pelo filtro
  },
  // "bloquear": mensagem sua com CPF/e-mail/termo é barrada antes de chegar ao Claude. "desligado": não filtra.
  filtro_de_mensagem: 'bloquear',
  // Conexões de banco: {"erp": {"driver": "mysql", "url": "mysql://usuario:${env:ERP_SENHA}@host/base"}}
  conexoes: {},
};

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadConfig() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(PATHS.config, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`config.json inválido em ${PATHS.config}: ${e.message}`);
  }
  const cfg = { ...DEFAULTS, ...user };
  cfg.ferramentas_externas = { ...DEFAULTS.ferramentas_externas, ...(user.ferramentas_externas || {}) };
  return cfg;
}

// termos.txt: um termo por linha; opcionalmente "termo | PREFIXO". Linhas com # são comentário.
export function loadTerms() {
  let txt = '';
  try {
    txt = fs.readFileSync(PATHS.termos, 'utf8').replace(/^﻿/, '');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const out = [];
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [term, prefix] = line.split('|').map((s) => s.trim());
    if (term) out.push({ term, prefix: (prefix || 'NAME').toUpperCase() });
  }
  return out;
}

// Normaliza nomes de coluna/campo para comparação: sem acento, minúsculo, só letras/números.
export function normName(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function loadRevealed() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.revelados, 'utf8'));
  } catch {
    return [];
  }
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (file, dir) => {
  const rel = path.relative(path.resolve(dir).toLowerCase(), path.resolve(file).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// Arquivos internos do cofre e arquivos já desmascarados: nenhuma ferramenta pode lê-los para o Claude.
export function forbiddenReason(file, cfg) {
  if (inside(file, DATA_DIR)) return 'pasta interna do cofre (chave, valores reais e configuração)';
  if (loadRevealed().some((r) => samePath(r, file))) return 'arquivo desmascarado (contém valores reais)';
  for (const dir of cfg?.pastas_protegidas || []) if (inside(file, dir)) return `pasta protegida (${dir})`;
  return null;
}

export function expandEnv(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{env:([A-Za-z0-9_]+)\}/g, (_, k) => process.env[k] ?? '');
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v)]));
  }
  return value;
}
