// PreToolUse (Read, Edit, Write, Grep, Bash, PowerShell...): impede o Claude de abrir direto
// planilhas/CSVs, a pasta do cofre e arquivos desmascarados. Ele deve usar as ferramentas do cofre.
import path from 'node:path';
import { DATA_DIR, forbiddenReason, loadRevealed } from '../lib/config.mjs';
import { readInput, safeConfig, preToolDecision } from './common.mjs';

const input = await readInput();
const cfg = safeConfig();
const ti = input.tool_input || {};
const cwd = input.cwd || process.cwd();
const exts = cfg.extensoes_protegidas.map((e) => e.toLowerCase().replace(/^\./, ''));
const masked = (p) => /\.mascarado\./i.test(path.basename(p));
const HINT = 'Use as ferramentas do cofre (estrutura, ler, comparar, exportar_mascarado), que entregam os dados como tokens.';

function checkFile(p) {
  if (!p) return null;
  const file = path.resolve(cwd, p);
  const why = forbiddenReason(file, cfg);
  if (why) return `Bloqueado pelo cofre: ${why}.`;
  const ext = path.extname(file).slice(1).toLowerCase();
  if (exts.includes(ext) && !masked(file)) return `Bloqueado pelo cofre: ${path.basename(file)} pode ter dados sensíveis. ${HINT}`;
  return null;
}

function checkCommand(cmd) {
  const low = cmd.toLowerCase().replace(/\//g, '\\');
  if (low.includes(DATA_DIR.toLowerCase()) || low.includes('.cofre-dados') || /cofre\.log|chave\.key|revelados\.json/.test(low)) {
    return 'Bloqueado pelo cofre: o comando acessa a pasta interna do cofre.';
  }
  for (const r of loadRevealed()) {
    if (low.includes(path.basename(r).toLowerCase())) return 'Bloqueado pelo cofre: o comando acessa um arquivo desmascarado.';
  }
  for (const dir of cfg.pastas_protegidas) {
    if (low.includes(path.resolve(dir).toLowerCase())) return `Bloqueado pelo cofre: o comando acessa a pasta protegida ${dir}.`;
  }
  const re = new RegExp(`[^\\s"'|<>;]*\\.(${exts.join('|')})(?![\\w])`, 'gi');
  for (const m of cmd.matchAll(re)) {
    if (!masked(m[0])) return `Bloqueado pelo cofre: o comando mexe em "${m[0]}". ${HINT} Para scripts, gere antes uma cópia com exportar_mascarado e use o arquivo *.mascarado.csv.`;
  }
  return null;
}

let reason = null;
switch (input.tool_name) {
  case 'Read':
  case 'Edit':
  case 'MultiEdit':
  case 'Write':
    reason = checkFile(ti.file_path);
    break;
  case 'NotebookEdit':
    reason = checkFile(ti.notebook_path);
    break;
  case 'Grep': {
    reason = checkFile(ti.path);
    const filter = `${ti.glob || ''} ${ti.type || ''}`.toLowerCase();
    if (!reason && exts.some((e) => new RegExp(`\\b${e}\\b`).test(filter) && !filter.includes('mascarado'))) {
      reason = `Bloqueado pelo cofre: busca em arquivos .${exts.join('/.')}. ${HINT}`;
    }
    if (!reason && !ti.glob && !ti.type) {
      // Busca ampla em pasta: exclui planilhas/CSVs do resultado em vez de bloquear.
      preToolDecision('allow', 'cofre: planilhas e CSVs excluídos da busca', {
        updatedInput: { ...ti, glob: `!*.{${exts.join(',')}}` },
      });
      process.exit(0);
    }
    break;
  }
  case 'Bash':
  case 'PowerShell':
    reason = checkCommand(String(ti.command || ''));
    break;
}

if (reason) preToolDecision('deny', reason);
