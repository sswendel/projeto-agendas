# Agendas

Aplicação web para um profissional organizar agenda, clientes, serviços, produtos sem estoque e lançamentos financeiros. O MVP usa React/Vite, Cloudflare Workers e D1; durante o desenvolvimento, o banco roda localmente.

## Começar localmente

Requisitos: Node.js 22.12 ou mais recente.

```powershell
npm install
npx wrangler d1 migrations apply projeto-agendas --local
npx wrangler d1 execute projeto-agendas --local --file=seed.local.sql
npm run dev
```

Abra o endereço local indicado pelo Vite. Para entrar na demonstração:

- E-mail: `demo@agendas.local`
- Senha: `AgendaLocal2026!`

O arquivo `seed.local.sql` contém apenas dados fictícios para desenvolvimento. Para experimentar uma conta própria, use “Criar conta”.

## O que já está no MVP

- Uma conta corresponde a um único profissional.
- Página pública para apresentar serviços e solicitar horários.
- A solicitação fica pendente por até 30 minutos; o profissional aprova ou recusa no aplicativo.
- Depois de solicitar, o cliente pode abrir o WhatsApp com uma mensagem já preenchida. O envio depende do cliente tocar em “Enviar”; não há API nem envio automático.
- O cliente recebe um link para acompanhar o estado do pedido.
- Cadastro de clientes, serviços e produtos (nome, descrição e preço; sem quantidades, entradas, saídas ou controle de estoque).
- Financeiro manual para contas a receber e pagar; não processa pagamentos nem importa dados bancários.

## Estrutura

- `src/`: interface React e estilos.
- `worker/index.ts`: API e regras do Worker.
- `migrations/`: schema SQL do D1.
- `seed.local.sql`: dados de demonstração para o D1 local.
- `wrangler.jsonc`: configuração do Worker e binding D1.

O build local pode ser conferido com `npm run build`.

## Ambiente publicado para avaliação

O app está publicado em [projeto-agendas.wendel-dak.workers.dev](https://projeto-agendas.wendel-dak.workers.dev), usando um Worker e um D1 da conta pessoal Cloudflare. O banco remoto recebeu apenas as migrações de estrutura: está vazio, sem usuário inicial e sem os dados fictícios de `seed.local.sql`. Crie uma conta pela tela inicial.

Esta primeira publicação serve para avaliação remota. Antes de divulgar para clientes ou inserir dados pessoais reais, ainda precisamos revisar privacidade/termos, recuperação de senha, proteção contra abuso automatizado e os demais controles operacionais. Não há domínio próprio configurado.
