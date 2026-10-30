// PreToolUse das ferramentas do cofre: valor real só é usado com a sua confirmação.
//  - consulta ao banco com tokens no SQL -> pergunta antes (os valores reais vão para o banco)
//  - desmascarar_arquivo                 -> pergunta antes (gera arquivo com valores reais)
import { TOKEN_RE } from '../lib/vault.mjs';
import { readInput, preToolDecision } from './common.mjs';

const input = await readInput();
const name = String(input.tool_name || '');
const ti = input.tool_input || {};

if (name.endsWith('__desmascarar_arquivo')) {
  preToolDecision(
    'ask',
    `Cofre: gerar arquivo com VALORES REAIS?\n  de:   ${ti.entrada}\n  para: ${ti.saida}\nO Claude não conseguirá ler o arquivo gerado.`,
  );
  process.exit(0);
}

const fontes = [ti.fonte, ti.esquerda, ti.direita].filter((f) => f && typeof f === 'object' && f.sql);
const tokens = new Set();
for (const f of fontes) for (const m of String(f.sql).matchAll(TOKEN_RE)) tokens.add(m[0]);

if (tokens.size) {
  const list = [...tokens];
  const shown = list.slice(0, 10).join(', ') + (list.length > 10 ? ` e mais ${list.length - 10}` : '');
  const bancos = [...new Set(fontes.map((f) => f.conexao))].join(', ');
  preToolDecision(
    'ask',
    `Cofre: esta consulta em "${bancos}" vai usar o valor real de ${list.length} token(s): ${shown}.\n` +
      'O valor real vai só para o banco (como parâmetro); o resultado volta mascarado para o Claude.',
  );
}
