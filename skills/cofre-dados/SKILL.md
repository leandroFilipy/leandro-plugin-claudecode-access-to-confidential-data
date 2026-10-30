---
name: cofre-dados
description: Use sempre que precisar ler, analisar, contar ou cruzar planilhas (.xlsx, .csv), dados de banco ou qualquer dado de empresa (vendas, custos, lucros, clientes, CPF, e-mail) — por exemplo "veja o que falta no banco que tem na planilha". Explica como trabalhar com dados mascarados por tokens do cofre.
---

# Trabalhando com o cofre de dados

Os dados sensíveis do usuário **não podem ser lidos diretamente**. Ler `.xlsx/.csv` com Read, Grep,
Bash ou PowerShell é bloqueado. Use as ferramentas MCP do servidor `cofre`:

| Ferramenta | Para quê |
|---|---|
| `estrutura` | Primeiro passo: abas, colunas, tipo, vazios, distintos, exemplos |
| `ler` | Linhas com valores trocados por tokens (paginar com `inicio`/`limite`) |
| `comparar` | Cruzar duas fontes pela chave: o que falta em cada lado e o que difere |
| `exportar_mascarado` | Cópia inteira tokenizada (`*.mascarado.csv`) para analisar com scripts |
| `listar_conexoes` | Bancos configurados |
| `desmascarar_arquivo` | Gera para o usuário um arquivo com valores reais (pede confirmação) |

Uma **fonte** é `{"arquivo": "C:/.../vendas.xlsx", "aba": "Plan1"}` ou `{"conexao": "erp", "sql": "SELECT ..."}`.

## Como os tokens funcionam

- `CPF#3f1a9c0d22e4`, `NAME#25aaae7143ac`, `NUM#...`, `BRL#...`: o prefixo é só etiqueta; o código depois do `#` depende apenas do valor.
- **Mesmo valor = mesmo código**, em qualquer arquivo, banco, coluna ou ferramenta. Dá para contar, agrupar, achar duplicados e cruzar.
- Normalização: maiúsculas, acentos e espaços não contam; `1.234,50` = `1234.5`; `123.456.789-09` = `12345678909`.
- Células vazias continuam vazias — dá para ver dado faltando.
- Datas e colunas configuradas como legíveis aparecem normais.
- Não dá para somar ou dizer se um valor é maior que outro: tokens só servem para igualdade. Se o usuário precisar de soma/média, diga que a coluna precisa estar em `colunas_legiveis` no config dele.

## Regras

1. Nunca tente descobrir o valor real de um token, nem peça ao usuário para revelá-lo na conversa.
2. Para "o que tem na planilha e não tem no banco (ou vice-versa)", use `comparar` — não leia 10 mil linhas.
3. SQL com token: use o token sozinho como valor — `WHERE cpf = CPF#3f1a9c0d22e4` ou `WHERE cliente IN (NAME#..., NAME#...)`.
   Não use token dentro de texto (`LIKE '%NAME#...%'` não funciona). O usuário confirma antes de o valor real ir ao banco.
   O cofre só executa SELECT/WITH.
4. Para análises pesadas, use `exportar_mascarado` e processe o `*.mascarado.csv` com Python/PowerShell.
5. Ao entregar resultados ao usuário, fale em tokens e números de linha (`#linha` = linha no Excel). Se ele quiser os nomes reais,
   salve o relatório em um arquivo e use `desmascarar_arquivo`.
6. Se uma mensagem do usuário chegar com tokens, trate-os como os valores que representam.
