// PostToolUse: mascara a saída de outras ferramentas antes de chegar ao Claude.
//  - Bash/PowerShell: troca CPF, CNPJ, e-mail, telefone, R$ e termos cadastrados por tokens.
//  - Outros MCPs (Jira, Notion, CRM, API interna): idem, e ainda aplica campos_legiveis /
//    campos_mascarados do config (ex.: "cliente" vira NAME#... inteiro; "titulo" fica legível).
import { loadTerms, normName } from '../lib/config.mjs';
import { Vault } from '../lib/vault.mjs';
import { makeTextMasker, classify, PREFIX } from '../lib/mask.mjs';
import { readInput, safeConfig, reply } from './common.mjs';

const input = await readInput();
const name = String(input.tool_name || '');
if (/cofre__/.test(name)) process.exit(0); // já sai mascarado

const cfg = safeConfig();
const ext = cfg.ferramentas_externas;
if (ext.ignorar_ferramentas.some((re) => new RegExp(re, 'i').test(name))) process.exit(0);

const isMcp = name.startsWith('mcp__');
const vault = new Vault(); // a chave só é aberta se algo precisar ser mascarado
const maskText = makeTextMasker(vault, loadTerms(), cfg.separador_decimal);
const legiveis = new Set(ext.campos_legiveis.map(normName));
const mascarados = new Set(ext.campos_mascarados.map(normName));
const prefixos = new Map(Object.entries(cfg.prefixo_por_coluna).map(([k, v]) => [normName(k), String(v).toUpperCase()]));
let changed = false;

function maskWhole(v, key) {
  const c = classify(v, cfg.separador_decimal);
  if (c.kind === 'vazio') return v;
  changed = true;
  const prefix = prefixos.get(normName(key)) || (c.kind === 'texto' ? 'NAME' : PREFIX[c.kind]);
  return vault.token(c.norm, c.raw ?? c.display, c.kind, prefix);
}

function walk(v, key) {
  const k = normName(key);
  if (isMcp && k && legiveis.has(k)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (isMcp && (t.startsWith('{') || t.startsWith('['))) {
      try {
        const before = changed;
        changed = false;
        const out = walk(JSON.parse(t), key);
        const inner = changed;
        changed = before || inner;
        if (inner) return JSON.stringify(out, null, v.includes('\n') ? 2 : undefined);
        return v;
      } catch {}
    }
    if (isMcp && mascarados.has(k)) return maskWhole(v, key);
    const m = maskText(v);
    if (m !== v) changed = true;
    return m;
  }
  if (typeof v === 'number' && isMcp && mascarados.has(k)) return maskWhole(v, key);
  if (Array.isArray(v)) return v.map((x) => walk(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, walk(vv, kk)]));
  return v;
}

const out = walk(input.tool_response, '');
if (changed) reply({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: out } });
