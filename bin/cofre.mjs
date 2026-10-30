#!/usr/bin/env node
// CLI do cofre, para VOCÊ usar no seu terminal (não peça para o Claude rodar "revelar").
//   node cofre.mjs iniciar                  cria ~/.cofre-dados com config, termos e chave
//   node cofre.mjs status
//   node cofre.mjs revelar CPF#3f1a9c0d22e4 mostra o valor real de um token
//   node cofre.mjs instalar-driver mysql    mysql | postgres | sqlserver | oracle
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DATA_DIR, PATHS, ensureDataDir } from '../lib/config.mjs';
import * as ops from '../lib/ops.mjs';

const [cmd, ...args] = process.argv.slice(2);

const CONFIG_TEMPLATE = {
  colunas_legiveis: ['status', 'uf', 'mes'],
  prefixo_por_coluna: { cliente: 'NAME', valor: 'BRL', custo: 'BRL' },
  tipos_legiveis: ['data'],
  separador_decimal: ',',
  extensoes_protegidas: ['xlsx', 'xlsm', 'xls', 'xlsb', 'csv', 'tsv', 'ods'],
  pastas_protegidas: [],
  ferramentas_externas: { campos_legiveis: ['titulo', 'responsavel', 'status'], campos_mascarados: ['cliente'], ignorar_ferramentas: [] },
  filtro_de_mensagem: 'bloquear',
  conexoes: {
    exemplo_mysql: { driver: 'mysql', url: 'mysql://usuario:${env:ERP_SENHA}@localhost:3306/base' },
  },
};

const TERMS_TEMPLATE = `# Um termo por linha. Ele vira token em qualquer lugar (planilha, Jira, terminal, sua mensagem).
# Opcional: "termo | PREFIXO" para escolher a etiqueta do token. Sem prefixo = NAME.
# Maiúsculas e acentos não importam.
#
# Acme Comercio Ltda | CLIENTE
# Maria da Silva
`;

const DRIVERS = { mysql: 'mysql2', postgres: 'pg', sqlserver: 'mssql', oracle: 'oracledb' };

switch (cmd) {
  case 'iniciar': {
    ensureDataDir();
    if (!fs.existsSync(PATHS.config)) fs.writeFileSync(PATHS.config, JSON.stringify(CONFIG_TEMPLATE, null, 2));
    if (!fs.existsSync(PATHS.termos)) fs.writeFileSync(PATHS.termos, TERMS_TEMPLATE);
    const ctx = ops.context();
    ctx.vault.size(); // cria a chave protegida
    console.log(`Cofre pronto em ${DATA_DIR}\n  - edite ${PATHS.config}\n  - cadastre nomes em ${PATHS.termos}`);
    break;
  }
  case 'status':
    console.log(ops.status(ops.context()));
    break;
  case 'revelar': {
    if (!args.length) throw new Error('uso: revelar TOKEN [TOKEN...]');
    const vault = ops.context().vault;
    for (const t of args) {
      const e = vault.lookup(t);
      console.log(`${t}\t${e ? e.v : '(não encontrado)'}`);
    }
    break;
  }
  case 'instalar-driver': {
    const pkg = DRIVERS[args[0]];
    if (!pkg) throw new Error(`driver desconhecido. Opções: ${Object.keys(DRIVERS).join(', ')}`);
    ensureDataDir();
    const pj = `${DATA_DIR}/package.json`;
    if (!fs.existsSync(pj)) fs.writeFileSync(pj, JSON.stringify({ name: 'cofre-dados-drivers', private: true }, null, 2));
    const r = spawnSync('npm', ['install', pkg], { cwd: DATA_DIR, stdio: 'inherit', shell: true });
    process.exit(r.status ?? 1);
  }
  default:
    console.log('comandos: iniciar | status | revelar TOKEN | instalar-driver mysql|postgres|sqlserver|oracle');
}
