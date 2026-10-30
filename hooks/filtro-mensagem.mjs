// UserPromptSubmit: se a SUA mensagem tiver CPF, CNPJ, e-mail, telefone, R$ ou um termo cadastrado,
// ela é barrada antes de chegar ao Claude e você recebe a versão com tokens para reenviar.
import { loadTerms } from '../lib/config.mjs';
import { Vault } from '../lib/vault.mjs';
import { makeTextMasker } from '../lib/mask.mjs';
import { readInput, safeConfig, reply } from './common.mjs';

const input = await readInput();
const cfg = safeConfig();
if (cfg.filtro_de_mensagem === 'desligado') process.exit(0);

const prompt = String(input.prompt || '');
const maskText = makeTextMasker(new Vault(), loadTerms(), cfg.separador_decimal);
const masked = maskText(prompt);

if (masked !== prompt) {
  reply({
    decision: 'block',
    reason:
      'Cofre: sua mensagem tinha dado sensível e NÃO foi enviada ao Claude.\n' +
      'Copie e reenvie a versão com tokens abaixo (o Claude entende os tokens e eles cruzam com as planilhas):\n\n' +
      masked,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
  });
}
