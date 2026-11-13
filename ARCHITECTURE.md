# Arquitetura e decisões

## Limites entre componentes

- `src/domain` contém as regras de valores monetários exatos e das solicitações de apostas; não depende do NestJS nem de ORM.
- `src/controllers` reúne os controllers HTTP.
- `src/services` reúne os casos de uso, métricas e workers de mensageria.
- `src/dtos` contém os objetos usados para validar os contratos de entrada HTTP.
- `src/database` mantém as migrations versionadas do PostgreSQL e a conexão com o TypeORM.
- HTTP e SQS chamam o mesmo caso de uso: `WageringService.process`.

## Estrutura de pastas

```text
.
├── src/
│   ├── app/                 # Módulo NestJS e tratamento de erros
│   ├── auth/                # Ponto de extensão para validar a identidade do provedor
│   ├── controllers/
│   │   ├── health.controller.ts
│   │   └── wagering.controller.ts
│   ├── database/
│   │   ├── migrations/      # Alterações versionadas e reversíveis no schema
│   │   ├── data-source.ts   # Configuração da conexão TypeORM/PostgreSQL
│   │   ├── migrate.ts       # Aplicação das migrations
│   │   ├── revert.ts        # Reversão da última migration
│   │   └── database-lifecycle.ts # Encerramento da conexão ao desligar
│   ├── domain/              # Money e regras/validação da entrada de apostas
│   ├── dtos/
│   │   └── wagering.dto.ts  # DTOs de criação de carteira e aposta
│   ├── services/
│   │   ├── metrics.service.ts
│   │   ├── outbox.publisher.ts
│   │   ├── sqs.service.ts
│   │   └── wagering.service.ts
│   └── main.ts              # Inicialização da aplicação NestJS
├── test/
│   ├── money.test.ts        # Testes unitários de valores e validações
│   └── wagering.integration.test.ts # Testes concorrentes com PostgreSQL
├── scripts/
│   └── init-localstack.sh   # Criação das filas SQS locais e da DLQ
├── .postman/
│   └── resources.yaml       # Configuração de recursos do Postman
├── postman/
│   └── globals/
│       └── workspace.globals.yaml # Variáveis globais do workspace Postman
├── ARCHITECTURE.md          # Decisões e desenho da arquitetura
├── README.md                # Requisitos, execução e uso da API
├── docker-compose.yml       # Serviços locais: aplicação, PostgreSQL e LocalStack
├── package.json             # Dependências e comandos do projeto
├── bun.lock                 # Versões fixadas das dependências Bun
├── tsconfig.json            # Configuração do TypeScript estrito
├── .env.example             # Exemplo de variáveis de ambiente
└── .gitattributes           # Regras de formatação de arquivos no Git
```

O fluxo normal começa em `main.ts`, que carrega o módulo NestJS em `app/`. Requisições HTTP são validadas com os DTOs em `dtos/` e encaminhadas pelos controllers em `controllers/`. Mensagens SQS são recebidas pelos serviços em `services/` e encaminhadas ao mesmo caso de uso de apostas. Os serviços aplicam as regras de `domain/` e persistem os resultados no PostgreSQL pela conexão e migrations de `database/`. Eventos para integração são publicados posteriormente pela Outbox. Os testes em `test/` cobrem as regras isoladas e os cenários que dependem do banco real.

## Correção financeira

`Money` armazena valores em centavos inteiros usando `bigint`. As entradas e saídas JSON usam strings decimais com escala fixa. O PostgreSQL armazena saldos e valores do ledger como `numeric(20,2)`; valores monetários nunca passam por `number` do JavaScript.

A transação do banco bloqueia apenas a linha da carteira em processamento, usando `SELECT ... FOR UPDATE`. A idempotência é verificada novamente após a aquisição do lock. Assim, solicitações simultâneas para a mesma carteira são serializadas, enquanto carteiras diferentes podem ser processadas em paralelo. A alteração da carteira, o estado da transação, o lançamento no ledger, o registro na Inbox e os eventos da Outbox são confirmados ou revertidos juntos.

As constraints do banco garantem uma carteira por jogador/moeda, idempotência das transações e unicidade dos identificadores do provedor, no máximo uma reversão de cada tipo por referência, saldos não negativos, um lançamento no ledger por transação e lançamentos imutáveis. O ledger registra os saldos anterior e posterior; a reconciliação compara o saldo materializado com a soma dos lançamentos.

## Idempotência e eventos

A `Idempotency-Key` obrigatória é armazenada sob uma constraint de unicidade no banco. O SHA-256 é calculado sobre um objeto JSON determinístico, com campos de negócio fixos e ordenados; metadados de transporte e o cabeçalho de idempotência são excluídos. Reenvios retornam o resultado armazenado; uma solicitação com payload diferente e a mesma chave gera conflito.

Os registros da Outbox são confirmados junto com o estado financeiro. Os publicadores reservam registros com `FOR UPDATE SKIP LOCKED` e um lease, e então os enviam para o SQS. Uma falha após o envio, mas antes do registro da publicação, pode causar uma nova entrega; por isso, os consumidores devem deduplicar usando `eventId`. A deduplicação da Inbox usa `(consumerName, messageId)`, e a mensagem SQS só é confirmada após o commit da transação no banco.

Mensagens que dependem de uma referência ainda inexistente permanecem em `PENDING_REFERENCE`. Um worker persistido no banco tenta processá-las novamente até oito vezes, com backoff exponencial (iniciando em cinco segundos e limitado a cinco minutos); depois, rejeita a transação. O SQS tenta novamente falhas transitórias e encaminha as mensagens para a DLQ configurada após cinco entregas.

## Estados e códigos de falha

Os caminhos válidos de processamento são `PENDING -> PROCESSED | REJECTED | PENDING_REFERENCE` e `PENDING_REFERENCE -> PROCESSED | REJECTED | PENDING_REFERENCE`. `PROCESSED`, `REJECTED` e `FAILED` são estados terminais. Erros de infraestrutura revertem a transação SQL e permitem uma nova tentativa, em vez de serem registrados como sucesso indevido.

Os códigos estáveis de rejeição incluem `INSUFFICIENT_FUNDS`, `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_CONTEXT_MISMATCH`, `REFERENCE_AMOUNT_MISMATCH`, `REFERENCE_ALREADY_REVERSED`, `INVALID_REFUND_REFERENCE`, `INVALID_WIN_REFERENCE` e `INVALID_ROLLBACK_REFERENCE`. Payloads inválidos e conflitos de idempotência são retornados como erros HTTP, e não são registrados como apostas processadas.

## Autenticação

A autenticação não foi implementada intencionalmente, pois não vale pontos na avaliação do desafio. `ProviderIdentityPort` é um ponto de extensão explícito e atualmente usa um adaptador sem operação. Substitua-o por um adaptador que valide a identidade do provedor por meio de um provedor de identidade OIDC externo; não armazene senhas localmente. Os endpoints de health check não exigem autenticação.

## Trade-offs e limitações

- O TypeORM é usado para gerenciar a conexão com o PostgreSQL e os query runners transacionais. O SQL permanece explícito para que locks de linha, constraints e migrations sejam visíveis.
- A implementação oferece suporte a carteiras em várias moedas; para o desafio, a implantação pode usar apenas BRL.
- As métricas são contadores e gauges Prometheus locais ao processo; portanto, cada réplica deve ser coletada e os dados agregados no backend de métricas.
- O consumidor SQS usa um loop de polling limitado; a visibilidade das mensagens é de 30 segundos. Aumente esse período ou renove-o para cargas em que o processamento possa exceder esse limite.
- No encerramento, uma mensagem cujo processamento já começou é concluída e confirmada; a visibilidade de uma mensagem recebida, mas ainda não processada, é liberada imediatamente.
- O adaptador de identidade sem operação não deve ser usado como mecanismo de autenticação em produção.
