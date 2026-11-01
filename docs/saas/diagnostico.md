# Comestra SaaS — Diagnóstico técnico inicial (Fase 1)

> Auditoria somente leitura feita antes da transformação multi-tenant, sobre a branch
> `feat/comestra-saas-multitenant` (criada a partir de `myhome`). Nove frentes analisadas em paralelo:
> autenticação/usuários, catálogo, pedidos, pagamentos, loja/infraestrutura, painel web, vitrine web,
> testes e documentação/marca. Resultado: **151 riscos** (15 críticos, 44 altos, 56 médios, 36 baixos).
> O status de cada item ao fim da implementação está em [`relatorio-final.md`](relatorio-final.md).

## 1. Ponto de partida

| Item | Situação encontrada |
|---|---|
| Stack | NestJS 11.1, TypeORM 0.3.28, PostgreSQL 18, JWT + bcrypt, Mercado Pago SDK 2.12, Sharp 0.34; React 19, Vite 7, Tailwind 4, React Router 7; Jest 30 e Playwright 1.63 |
| Tenancy | **Nenhuma.** Uma loja só: `store_config` com uma linha; nenhuma tabela tinha `store_id` |
| Schema | Sem migrations: `synchronize` do TypeORM em dev/test e instrução de "subir uma vez com synchronize" em produção |
| Papéis | `users.role` único (CLIENT, ADMIN, EMPLOYEE, KITCHEN, COURIER); ADMIN com acesso a qualquer usuário |
| Pagamentos | Um único `MP_ACCESS_TOKEN` global; chave pública fixa no front (com fallback de teste) |
| Testes | 261 testes unitários (Jest) e 588 E2E (Playwright) verdes, todos assumindo loja única |
| Qualidade | Lint e type-check limpos no backend e no frontend web; código cuidadoso (regras puras testadas, retratos de preço, idempotência de pagamentos, fail-closed por ambiente) |
| Marca | Rebrand para Comestra já feito; restos de "Torres" só em notas de migração, migração de chaves antigas e testes que garantem a ausência do nome |
| Dados de dev | Banco `comestra`: 23 usuários, 27 produtos, 10 adicionais, 39 pedidos, 85 itens, 2 pagamentos |

## 2. Riscos críticos

| # | Área | Risco | Tratamento |
|---|---|---|---|
| C1 | Pedidos | Equipe de qualquer loja leria, alteraria, cancelaria e estornaria pedidos de outra (consultas só por id; regras olham só o perfil) | `store_id` em todas as consultas e escritas; 404 uniforme; triggers no banco |
| C2 | Pedidos | Leitura cruzada de dados pessoais de clientes (lista, detalhe, "pedidos próximos") | Idem; endereço vivo omitido quando há retrato |
| C3 | Transversal | **TypeORM ignora filtros `null`/`undefined` no `where`**: `{ store_id: undefined }` devolveria todas as lojas | `invalidWhereValuesBehavior: { null: 'throw', undefined: 'throw' }` |
| C4 | Pedidos/Catálogo | Orçamento e pedido aceitavam produtos e adicionais de outra loja (e revelavam nomes do catálogo alheio) | Filtro por loja + mesma mensagem de "não encontrado" + triggers |
| C5 | Pagamentos | Credencial MP única: o dinheiro de todas as lojas cairia na mesma conta | Credenciais por loja (cifradas); env só para a loja padrão |
| C6 | Pagamentos | Valor cobrado calculado fora do catálogo da loja | Precificação com a loja da rota |
| C7 | Pagamentos | Estorno disparável pela equipe de outra loja | Pedido e pagamento conferidos pela loja antes de cancelar/estornar |
| C8 | Catálogo | Escritas por id sem escopo de loja (IDOR/BOLA) | Critério composto `{ id, store_id }` com conferência de `affected` |
| C9 | Catálogo | Adicional de outra loja vinculado a produto e cobrado | Filtro por loja + trigger em `product_allowed_addons` |
| C10 | Usuários | BOLA em todas as rotas administrativas de `/users` | Equipe escopada pela loja do ADMIN; 404 fora dela |
| C11 | Usuários | Tomada de conta: ADMIN trocaria e-mail/senha de clientes globais e de outras lojas | ADMIN só gerencia a equipe da própria loja; clientes e plataforma fora do alcance |
| C12 | Usuários | Escalonamento de perfil entre lojas (criar/promover/rebaixar) | Perfis de equipe só na própria loja; papel global nunca por HTTP |
| C13 | Painel web | Tela Equipe expunha e editava clientes globais | Equipe só da loja; clientes em tela própria, somente leitura |
| C14 | Vitrine web | Chave pública MP global com fallback de teste e SDK único | Chave pública por loja no perfil público |
| C15 | Testes | O estado intermediário quebraria o setup do E2E (CHECK da equipe sem seed de loja) | Seed de loja demo + superadmin (dev/test) e E2E com loja padrão explícita |

## 3. Riscos altos (resumo por área)

- **Identidade**: último ADMIN global (passa a ser por loja); exposição em massa em `GET /users`; ausência
  de limite de tentativas e de bloqueio de conta; JWT sem versão (sessões não revogáveis); segredo JWT de
  dev fixo; ausência de recuperação de senha; entregadores consultados sem loja.
- **Pedidos**: dashboard agregando todas as lojas; pedidos criados por pagamento sem loja; presenter que
  vazaria a entidade `Store`; estorno com credencial global.
- **Pagamentos**: polling de status aberto a toda equipe; idempotência sem loja; `POST /orders` com
  `paymentId` de outra loja; `external_reference` sem loja; cobrança feita antes de gravar o registro;
  conciliação global que uma credencial inválida poderia travar; troca de credencial quebrando consultas.
- **Catálogo**: leituras públicas e lixeira de todas as lojas; manutenção de imagens com alcance de
  plataforma liberada a ADMIN de loja; imagens sem dono (referência cruzada).
- **Loja/infra**: runtime ainda lendo `store_config`; seed de usuários violando o CHECK; servidor de dev em
  modo watch aplicando migrations no banco `comestra` sem aviso (mitigado com backup — ver seção 5).
- **Web**: painel dependente de rotas públicas que apontariam para a loja padrão; lixeira de usuários
  global; superadmin sem como entrar; carrinho único misturando lojas; PIX em andamento por usuário (não
  por loja); dados da loja fixos no código; login/cadastro perdendo o contexto da loja.
- **Testes**: synchronize depois das migrations mascarando migrations faltantes; loja padrão indefinida no
  E2E; testes que consolidavam o poder do ADMIN sobre contas globais; E2E sem superadmin.
- **Documentação**: variáveis críticas de produção sem documentação; instruções de schema obsoletas;
  bootstrap do superadmin apontando para tela que o rejeitava; loja padrão implícita.

## 4. Dependências e ordem

```
Fundação (schema + migrations + tenancy + auth + auditoria + limites)
  └─► Módulos da loja (catálogo, pedidos, pagamentos, identidade, loja, cobrança SaaS)
        └─► Superpainel (lojas, usuários, indicadores, auditoria, configurações, suporte)
              └─► Frontend web (sessão, rotas, painel da loja, superpainel, vitrine por slug)
                    └─► E2E (ajuste dos existentes + isolamento, superadmin, assinaturas)
                          └─► Revisão de segurança e validação final
```

- O app mobile depende das rotas antigas: elas passam a atuar na **loja padrão** (ou na loja da equipe
  autenticada nas leituras), preservando os contratos.
- A cobrança recorrente real depende de credenciais da conta Mercado Pago da **plataforma**
  (`MP_SAAS_ACCESS_TOKEN`, `MP_SAAS_WEBHOOK_SECRET`) — ainda não existentes.
- O envio de e-mails depende de um provedor transacional — ainda não contratado.

## 5. Riscos operacionais imediatos e providências

| Risco | Providência |
|---|---|
| `nest start --watch` do usuário aplicaria as migrations no banco `comestra` ao compilar | Migration validada antes em cópias (banco vazio, cópia do dev, ida e volta); **backup íntegro criado**: banco `comestra_backup_pre_saas` |
| Dados de demonstração da vitrine antiga (endereço/telefone/horário fixos) gravados na loja inicial | Registrado na auditoria da migração; checklist pós-migração na documentação de operação |
| Mensagens antigas com mais de 200 caracteres abortariam a migração | Truncadas na migração |

## 6. Plano de implementação (fases do pedido)

1. **Auditoria** — este documento.
2. **Fundação multi-tenant** — entidades, migrations (baseline + fundação), resolução do tenant, guards,
   capacidades por situação da loja/assinatura, JWT com versão, auditoria, limites, criptografia de credenciais,
   seeds de demonstração, CLI do superadmin.
3. **Superpainel** — autenticação global, dashboard, lojas, usuários, auditoria, sessões de suporte.
4. **Operação independente das lojas** — catálogo, pedidos, entregas, clientes, configurações, pagamentos, relatórios.
5. **Planos e assinaturas** — planos configuráveis, estados e transições, limites, rotina de cobrança, provedores.
6. **Rebranding** — separação definitiva entre a marca da plataforma e a identidade de cada loja.
7. **Validação final** — build, lint, testes unitários, E2E, revisão de segurança, validação das migrations.

Decisões e contratos: [`arquitetura.md`](arquitetura.md).
