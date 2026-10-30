// Servidor MCP (stdio, JSON-RPC por linha) do cofre. Sem dependências.
import readline from 'node:readline';
import * as ops from '../lib/ops.mjs';

const FONTE = {
  type: 'object',
  description: 'De onde ler. Arquivo: {"arquivo": "C:/caminho/vendas.xlsx", "aba": "Plan1"}. Banco: {"conexao": "erp", "sql": "SELECT ..."}.',
  properties: {
    arquivo: { type: 'string', description: 'Caminho de .xlsx, .xlsm, .csv, .tsv ou .txt' },
    aba: { type: 'string', description: 'Nome da aba (padrão: primeira)' },
    linha_cabecalho: { type: 'integer', description: 'Número da linha do cabeçalho no Excel (padrão: primeira linha não vazia)' },
    separador: { type: 'string', description: 'Separador do CSV (padrão: detecta)' },
    conexao: { type: 'string', description: 'Nome da conexão configurada (ver listar_conexoes)' },
    sql: { type: 'string', description: 'Consulta SELECT. Pode usar tokens como valor: WHERE cpf = CPF#3f1a9c0d22e4 ou IN (NAME#..., NAME#...)' },
  },
};

const PAR = {
  description: 'Nome da coluna (igual nos dois lados) ou {"esquerda": "...", "direita": "..."}',
  anyOf: [{ type: 'string' }, { type: 'object', properties: { esquerda: { type: 'string' }, direita: { type: 'string' } }, required: ['esquerda', 'direita'] }],
};

const TOOLS = [
  {
    name: 'estrutura',
    description: 'Mostra abas, colunas, tipo de cada coluna, quantos vazios e distintos, e exemplos mascarados. Comece por aqui.',
    inputSchema: { type: 'object', properties: { fonte: FONTE }, required: ['fonte'] },
    run: ops.estrutura,
  },
  {
    name: 'ler',
    description: 'Lê linhas de uma planilha/CSV/consulta com os valores trocados por tokens (mesmo valor = mesmo token). Vazios continuam vazios.',
    inputSchema: {
      type: 'object',
      properties: {
        fonte: FONTE,
        inicio: { type: 'integer', description: 'Primeira linha de dados (1 = logo após o cabeçalho)', default: 1 },
        limite: { type: 'integer', description: 'Quantas linhas (máx. 2000)', default: 50 },
        colunas: { type: 'array', items: { type: 'string' }, description: 'Só estas colunas' },
      },
      required: ['fonte'],
    },
    run: ops.ler,
  },
  {
    name: 'comparar',
    description:
      'Cruza duas fontes (planilha x banco, planilha x planilha...) pela chave e diz o que falta em cada lado e quais valores diferem. ' +
      'A comparação usa os valores reais internamente e devolve só tokens. Ignora maiúsculas, acentos e formato de número/data.',
    inputSchema: {
      type: 'object',
      properties: {
        esquerda: FONTE,
        direita: FONTE,
        chave: { description: 'Coluna(s) que identificam a linha', anyOf: [PAR, { type: 'array', items: PAR }] },
        colunas: { type: 'array', items: PAR, description: 'Colunas a comparar (padrão: as de mesmo nome nos dois lados)' },
        limite: { type: 'integer', description: 'Quantos exemplos listar por seção', default: 30 },
        salvar_em: { type: 'string', description: 'Opcional: caminho para salvar o relatório completo (mascarado, .json)' },
      },
      required: ['esquerda', 'direita', 'chave'],
    },
    run: ops.comparar,
  },
  {
    name: 'exportar_mascarado',
    description: 'Grava uma cópia inteira da fonte com tokens no lugar dos valores (arquivo *.mascarado.csv). Essa cópia pode ser lida e processada com scripts à vontade.',
    inputSchema: { type: 'object', properties: { fonte: FONTE, saida: { type: 'string', description: 'Caminho do .csv de saída' } }, required: ['fonte', 'saida'] },
    run: ops.exportarMascarado,
  },
  {
    name: 'listar_conexoes',
    description: 'Lista os bancos configurados pelo usuário (nome e tipo).',
    inputSchema: { type: 'object', properties: {} },
    run: ops.listarConexoes,
  },
  {
    name: 'desmascarar_arquivo',
    description:
      'Gera, para o USUÁRIO, uma cópia de um arquivo seu (relatório, CSV mascarado, script SQL) com os tokens trocados pelos valores reais. ' +
      'Pede confirmação ao usuário. Você não poderá ler o arquivo gerado.',
    inputSchema: { type: 'object', properties: { entrada: { type: 'string' }, saida: { type: 'string' } }, required: ['entrada', 'saida'] },
    run: ops.desmascararArquivo,
  },
  {
    name: 'status',
    description: 'Mostra a configuração do cofre (quantos valores guardados, colunas legíveis, conexões).',
    inputSchema: { type: 'object', properties: {} },
    run: ops.status,
  },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'cofre', version: '1.0.0' },
      instructions:
        'Cofre de dados sensíveis. Planilhas, CSVs e bancos da empresa devem ser lidos SOMENTE por estas ferramentas; ' +
        'valores voltam como tokens PREFIXO#hash (mesmo valor = mesmo token). Nunca tente descobrir o valor real.',
    };
  }
  if (method === 'tools/list') return { tools: TOOLS.map(({ run, ...t }) => t) };
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) throw Object.assign(new Error(`ferramenta desconhecida: ${params?.name}`), { code: -32602 });
    try {
      const text = await tool.run(ops.context(), params.arguments || {});
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Erro: ${e.message}` }], isError: true };
    }
  }
  if (method === 'ping') return {};
  if (id === undefined) return undefined; // notificação
  throw Object.assign(new Error(`método não suportado: ${method}`), { code: -32601 });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } });
  }
  try {
    const result = await handle(msg);
    if (msg.id !== undefined && result !== undefined) send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (e) {
    if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message } });
  }
});
