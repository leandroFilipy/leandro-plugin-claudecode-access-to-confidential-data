# cofre-dados — plugin do Claude Code

Troca dados sensíveis (vendas, custos, lucros, clientes, CPF, e-mail...) por **tokens antes do Claude ler**.

- **Mesmo valor, mesmo token**: o Claude ainda conta, cruza e compara.
- O valor real fica num **cofre cifrado na sua máquina** (AES-256-GCM, chave protegida pelo DPAPI do Windows).
- O valor real só é usado com a **sua confirmação**.

```
- CPF 123.456.789-09, contato maria@acme.com. Falou com a Maria.
+ CPF CPF#3f1a9c0d22e4, contato EMAIL#91bd0e4a7c13. Falou com a NAME#6f100db288e4.
```

## Como funciona

| Peça | O que faz |
|---|---|
| Servidor MCP `cofre` | Lê `.xlsx/.csv` e bancos com os valores reais **dentro do seu PC** e devolve só tokens: `estrutura`, `ler`, `comparar`, `exportar_mascarado`, `desmascarar_arquivo` |
| Hook `guarda` | Bloqueia o Claude de abrir planilhas/CSVs direto (Read, Grep, Bash, PowerShell) e de tocar na pasta do cofre |
| Hook `confirmar` | Pergunta a você antes de um token virar valor real (consulta ao banco com token, gerar arquivo desmascarado) |
| Hook `mascarar-saida` | Mascara a saída do terminal e de outros MCPs (Jira, Notion, CRM, API interna) |
| Hook `filtro-mensagem` | Se você colar CPF/e-mail/termo na conversa, a mensagem é barrada e você recebe a versão com tokens |

Normalização: `ACME COMÉRCIO` = `Acme Comercio`, `1.234,50` = `1234.5`, `123.456.789-09` = `12345678909`.
Por isso a planilha cruza com o banco mesmo com formatos diferentes.

## Instalação

```powershell
claude plugin marketplace add C:\Users\leandrofl\Downloads\plugin-for-data
claude plugin install cofre-dados@cofre-local
node C:\Users\leandrofl\Downloads\plugin-for-data\bin\cofre.mjs iniciar
```

Reinicie o Claude Code depois de instalar.

## Configuração (você edita; o Claude não consegue ler)

`%USERPROFILE%\.cofre-dados\config.json`

```jsonc
{
  "colunas_legiveis": ["status", "uf"],          // ficam legíveis (o resto vira token)
  "prefixo_por_coluna": { "cliente": "NAME", "valor": "BRL" },
  "tipos_legiveis": ["data"],                     // datas legíveis em qualquer coluna
  "ferramentas_externas": {                       // Jira, Notion, CRM...
    "campos_legiveis": ["titulo", "responsavel"],
    "campos_mascarados": ["cliente"]
  },
  "filtro_de_mensagem": "bloquear",               // ou "desligado"
  "conexoes": {
    "erp": { "driver": "mysql", "url": "mysql://usuario:${env:ERP_SENHA}@host:3306/base" }
  }
}
```

Drivers: `sqlite` (já vem), `mysql`, `postgres`, `sqlserver`, `oracle`. Para instalar:
`node ...\bin\cofre.mjs instalar-driver mysql`. Senha pode vir de variável de ambiente com `${env:NOME}`.

`%USERPROFILE%\.cofre-dados\termos.txt` — nomes soltos em texto (cliente, fornecedor, pessoa). Um por linha,
opcional `termo | PREFIXO`. **Nome que não está na lista passa**: troque por um apelido ou cadastre aqui.

## Uso

Peça normalmente, por exemplo:

> Compare `C:\dados\vendas.xlsx` com a tabela `vendas` do banco `erp` pelo número do pedido e me diga o que falta em cada lado.

Para ver o valor real de um token, rode **no seu terminal** (não peça ao Claude):

```powershell
node C:\Users\leandrofl\Downloads\plugin-for-data\bin\cofre.mjs revelar CPF#3f1a9c0d22e4
```

## Limites

- Tokens servem para igualdade: contar, agrupar, cruzar, achar faltantes/duplicados. **Somar ou comparar maior/menor exige a coluna em `colunas_legiveis`.**
- `.xls` antigo: salve como `.xlsx` ou `.csv`.
- O bloqueio de comandos no terminal é por nome de arquivo/pasta; ele cobre o uso normal, não um script feito para driblar o filtro.
- Nomes em texto livre só são mascarados se estiverem em `termos.txt`.

## Teste

`node test/teste.mjs` — gera planilha de 10 mil linhas e banco SQLite falsos num cofre temporário e verifica tudo.
