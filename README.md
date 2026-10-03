# Mini Helpdesk

Aplicação web para registrar tickets de suporte e acompanhá-los em um Kanban (Backlog → Em andamento → Stage → Concluído), com histórico de tudo que acontece em cada ticket. Feita para o desafio prático da Delta Sistemas.

- **Frontend:** HTML, CSS e JavaScript puro (`fetch()` para falar com o backend)
- **Backend:** Python + Flask (rotas e sessão)
- **Banco:** PostgreSQL (na Neon, quando publicado), acessado com SQL puro e *prepared statements*
- **Hospedagem:** Vercel (backend e frontend) + Neon (banco)

## Estrutura

```
mini-helpdesk/
├── frontend/          index.html, style.css, app.js
├── backend/           app.py  (rotas, regras de permissão, acesso ao banco)
├── database/          schema.sql  (tabelas, regras e dados de teste)
├── requirements.txt   bibliotecas para rodar localmente
├── pyproject.toml     usado pela Vercel (diz onde está o "app")
└── .env.example       modelo das variáveis de ambiente
```

## Como rodar localmente

Você precisa de **Python 3.12+** e de um **PostgreSQL** (pode ser um banco grátis da [Neon](https://neon.tech) ou um Postgres instalado na máquina).

1. Crie e ative um ambiente virtual e instale as bibliotecas:
   ```
   python -m venv .venv
   source .venv/bin/activate        # no Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```
2. Copie `.env.example` para `.env` e preencha:
   - `DATABASE_URL`: o endereço do seu banco (na Neon, é a *connection string*).
   - `SECRET_KEY`: um texto aleatório. Gere com `python -c "import secrets; print(secrets.token_hex(32))"`.
3. Crie as tabelas e os dados de teste (**apaga as tabelas se já existirem**):
   ```
   psql "$DATABASE_URL" -f database/schema.sql
   ```
   Alternativa: abrir o *SQL Editor* da Neon, colar o conteúdo de `database/schema.sql` e executar.
4. Suba o servidor:
   ```
   python backend/app.py
   ```
5. Abra http://localhost:8000

### Usuários de demonstração

| Nome | E-mail | Senha | Perfil |
|---|---|---|---|
| Ana | ana@helpdesk.com | `h#h2XqPvu9r` | Comum |
| Bruno | bruno@helpdesk.com | `m4j@Mzr5xqW` | Suporte |
| Carla | carla@helpdesk.com | `9Sc#8bdumyG` | Suporte |

São contas fictícias, só para avaliação. Qualquer pessoa pode criar a própria conta em "Cadastre-se" (sempre como usuário comum).

### Quem é do suporte

O sistema tem dois perfis, guardados na coluna `perfil` da tabela `usuarios`: **comum** (quem abre chamados) e **suporte** (a equipe que atende). Não existe uma conta "administradora": os poderes extras pertencem à própria equipe de suporte. Quem se cadastra pelo site entra sempre como `comum`; para alguém virar suporte, o perfil é mudado direto no banco:

```sql
UPDATE usuarios SET perfil = 'suporte' WHERE email = 'email@da.pessoa';
```

## Como publicar (GitHub + Vercel + Neon)

1. Suba o projeto para um repositório no GitHub (o `.env` já está no `.gitignore` e **não** vai junto).
2. Na Vercel: *Add New → Project*, importe o repositório. A Vercel reconhece o Flask sozinha.
3. Ainda na Vercel, em *Storage*, crie um banco **Neon** e conecte ao projeto. Isso cria a variável `DATABASE_URL` automaticamente (confira o nome da variável no painel; se vier com outro nome, crie `DATABASE_URL` com o mesmo valor).
4. No painel da Neon (*SQL Editor*), execute o `database/schema.sql`.
5. Em *Settings → Environment Variables* da Vercel, crie `SECRET_KEY` com um texto aleatório.
6. Faça um novo *deploy* para as variáveis valerem.

## Telas

1. **Login** e 2. **Cadastro**
3. **Kanban** com quatro colunas, abas "Meus tickets" / "Todos os tickets" e filtros
4. **Novo ticket / Editar ticket** (janela)
5. **Detalhes do ticket** (janela): dados, ações disponíveis para quem está logado e histórico em linha do tempo

## Regras de negócio

**Etapas.** Todo ticket novo nasce no Backlog (o servidor ignora qualquer etapa enviada na criação). O fluxo é `Backlog ↔ Em andamento ↔ Stage → Concluído`: não é possível pular etapas e, enquanto não concluído, dá para voltar uma etapa. **Concluído é o fim do fluxo:** o ticket concluído não pode ser movido nem editado por ninguém. Não incluí "reabrir" porque o enunciado não pede e deixa as regras mais simples; um problema que volte depois é aberto como um novo ticket.

**Responsável.** Interpretei "responsável" como **quem abriu o ticket** (o solicitante), e não como quem vai resolvê-lo: quem abre um chamado de suporte não escolhe quem vai atendê-lo. Por isso há um só campo no banco (`criado_por`), mostrado na tela como **"Criado por"**. A palavra "Responsável" aparece apenas no formulário de criação: para usuário comum o campo vem fixo com o próprio nome; o **suporte** pode abrir um ticket em nome de outra pessoa (o histórico registra "criou o ticket em nome de X" e quem abriu de fato). Depois de criado, o responsável não muda.

**Quem pode o quê** (conferido no backend em toda requisição):

| Ação | Usuário comum | Suporte |
|---|---|---|
| Ver todos os tickets e histórico | Sim | Sim |
| Criar ticket | Sim (em seu nome) | Sim (em seu nome ou no de outra pessoa) |
| Mover entre etapas | Não | Qualquer ticket não concluído |
| Editar título, descrição e prioridade | Só os que criou **e** só no Backlog | Qualquer ticket que não esteja Concluído |
| Trocar o responsável depois de criado | Não | Não |
| Excluir | Só os que criou **e** só no Backlog | Qualquer ticket, **só no Backlog** |

**Confirmações.** Pedem confirmação: concluir e excluir. Mover entre Backlog, Em andamento e Stage é direto, com aviso na tela.

**Histórico.** Registra criação, mudança de etapa, conclusão, reabertura, mudança de prioridade e edição de título/descrição, sempre com quem fez e quando (e valor anterior e novo, quando existem).

**"Meus tickets".** São os tickets em que eu sou o responsável (`criado_por`), incluindo os que o suporte abriu em meu nome.

**Exclusão.** É *lógica*: o ticket recebe `excluido = TRUE` e some do sistema, mas a linha e o histórico continuam no banco. Para o suporte a regra é a mesma do usuário comum (só no Backlog); depois que um ticket entra no atendimento, ninguém exclui, para preservar o histórico.

**Ordenação.** Em cada coluna, prioridade alta primeiro e, dentro dela, os atualizados mais recentemente.

## Modelo do banco

```
usuarios 1 ──< N tickets      (criado_por = o responsável)
tickets  1 ──< N historico
usuarios 1 ──< N historico    (quem fez a ação)
```

Três tabelas, com chaves primárias e estrangeiras, `NOT NULL`, `UNIQUE` no e-mail e `CHECK` para prioridade, etapa, perfil e tipo de ação (o banco recusa valores inválidos mesmo que o código erre). Os índices existem só onde há consulta que os usa (etapa, criador e ticket do histórico). Mudar a etapa e gravar o histórico acontecem na **mesma transação**: ou as duas coisas são salvas, ou nenhuma.

## Segurança (o básico, bem aplicado)

- Senhas com `generate_password_hash` / `check_password_hash` (nunca em texto puro).
- Sessão por cookie assinado (`HttpOnly`, `SameSite=Lax`, `Secure` na Vercel). A `SECRET_KEY` não tem valor padrão: sem ela o servidor nem inicia.
- Toda rota exige login, a não ser as poucas listadas como públicas (proteção "por padrão").
- Permissões conferidas no backend; esconder botão na tela é só conforto visual.
- O perfil nunca vem do navegador: o cadastro ignora qualquer `perfil` enviado e cria sempre `comum`.
- SQL sempre com parâmetros (`%s`), nunca com texto do usuário colado na consulta.
- XSS: o frontend usa `textContent` para tudo que vem do banco.
- Validação de tamanho e valores no servidor; erro de login com mensagem única (não revela se o e-mail existe).
- Os endpoints de escrita só aceitam JSON, o que, somado ao `SameSite=Lax`, dificulta ataques CSRF.

## Decisões técnicas

- **Flask em vez de PHP puro.** A Vercel não executa PHP oficialmente e não guarda sessões em arquivo (cada requisição pode cair numa função diferente). Flask guarda a sessão num cookie assinado, o que resolve isso com pouco código.
- **PostgreSQL em vez de MySQL.** A Vercel não hospeda banco; o Postgres da Neon é o que se conecta direto pelo painel dela. A modelagem é a mesma.
- **SQL puro, sem ORM.** O SQL fica à vista e é fácil de explicar.
- **Perfil "suporte" em vez de "admin".** O nome diz o que a pessoa faz (atender chamados) e evita sugerir poderes de administração do sistema, que não existem aqui.
- **O backend também entrega o frontend**, então não há CORS para configurar.
- **Botões em vez de arrastar e soltar** para mover tickets: mais simples e funciona igual no celular.
- **Janelas nativas (`<dialog>`)** para detalhes, formulário e confirmação, em vez de uma biblioteca.

## Premissas

- "Responsável" = quem abriu o ticket. Quem **atende** não é registrado como campo: o histórico mostra quem moveu o ticket em cada etapa. Se o enunciado quis dizer o contrário (responsável = quem resolve), a mudança é adicionar uma coluna `atendente_id` em `tickets`.
- Só o suporte move tickets entre as etapas (quem atende); usuário comum acompanha. É uma linha em `pode_mover()` no `app.py` caso se queira permitir também ao criador.
- Os usuários de suporte vêm do `schema.sql`. Não existe tela para promover alguém a suporte (isso é feito direto no banco).
- Não incluí filtro por etapa, porque o Kanban já separa os tickets por etapa.

## Limitações conhecidas

- **Publicação na Vercel ainda não testada de ponta a ponta.** O backend e a interface foram testados localmente (API e navegador), mas o *deploy* na Vercel/Neon depende de configuração na conta e deve ser validado após publicar. O ponto de atenção é o Flask encontrar a pasta `frontend/` no ambiente da Vercel; se não encontrar, a solução é mover os arquivos do frontend para uma pasta `public/`.
- Como o responsável é fixo, um ticket aberto no nome errado só se corrige excluindo (possível apenas no Backlog) e criando de novo.
- Sem limite de tentativas de login (um ataque de força bruta não é bloqueado).
- Sem token CSRF dedicado (a proteção é a combinação JSON + `SameSite=Lax`).
- Sem recuperação de senha, sem confirmação de e-mail e sem tela de gerenciamento de usuários.
- Sem tela para ver tickets excluídos nem para desfazer exclusão.
- Sem paginação: todos os tickets são carregados de uma vez.
- Sem testes automatizados no repositório (a verificação foi manual e por scripts descartáveis).
- O Kanban não se atualiza sozinho: outra pessoa mexendo no mesmo ticket só aparece depois de recarregar. O servidor detecta o conflito e avisa quem tentou mover um ticket já alterado.
- Os dados de teste do `schema.sql` têm senhas publicadas neste README: apague-os antes de qualquer uso real.

## Possíveis evoluções

- **Setor de quem abriu o ticket.** Um campo `setor` no usuário (preenchido no cadastro, de preferência por uma lista fixa para não haver "Financeiro" e "financeiro" como setores diferentes) e exibido nos detalhes do ticket ("Criado por Ana · Financeiro"). Ajudaria o suporte a saber de onde vem o chamado. Fica de fora agora por não fazer parte do fluxo principal pedido.
- Testes automatizados da API (por exemplo, com `pytest`) e das regras de permissão.
- Limite de tentativas de login e token CSRF.
- Arrastar e soltar no Kanban; atualização automática da tela.
- Tela de gerenciamento de usuários (com um perfil `admin` separado do suporte), comentários nos tickets, anexos, prazos (SLA).
- Migrações de banco versionadas (em vez de recriar tudo pelo `schema.sql`).

### O que eu usaria das ferramentas deixadas de fora, e por quê

- **TypeScript:** o primeiro que adotaria; pega erros de tipo cedo e ajuda a manter o `app.js` conforme ele cresce.
- **ORM** (como SQLAlchemy): quando houver muitas tabelas e consultas, para reduzir repetição. Hoje o SQL puro é mais claro.
- **React/Next.js:** se a interface ganhasse muitas telas e estados; para três telas, JavaScript puro basta.
- **Docker:** para o ambiente ser igual em qualquer máquina e facilitar o CI.
- **JWT:** só se houvesse um app móvel ou outra API consumindo o sistema; para um navegador, o cookie de sessão é mais simples e seguro.
- **Tailwind ou Bootstrap:** para padronizar o visual numa equipe maior; aqui o CSS próprio é pequeno e fácil de explicar.
