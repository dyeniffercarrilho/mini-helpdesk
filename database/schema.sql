-- =====================================================================
-- Banco de dados do Mini Helpdesk (PostgreSQL)
--
-- MODELO CONCEITUAL (3 tabelas):
--
--   usuarios 1 ----< N tickets    (um usuário é o RESPONSÁVEL por vários tickets:
--                                  quem abriu, ou em nome de quem o suporte abriu)
--   tickets  1 ----< N historico  (um ticket tem vários registros de histórico)
--   usuarios 1 ----< N historico  (um usuário REALIZA várias ações)
--
-- Como usar: cole este arquivo inteiro no "SQL Editor" da Neon e execute,
-- ou rode:  psql "$DATABASE_URL" -f database/schema.sql
--
-- ATENÇÃO: ele APAGA as tabelas e cria tudo de novo.
-- =====================================================================

DROP TABLE IF EXISTS historico;
DROP TABLE IF EXISTS tickets;
DROP TABLE IF EXISTS usuarios;

-- ---------------------------------------------------------------------
-- USUÁRIOS
-- email é UNIQUE: não pode haver duas contas com o mesmo e-mail.
-- senha_hash guarda o hash gerado pelo Python (nunca a senha em si).
-- perfil: 'comum' (padrão no cadastro) ou 'suporte' (equipe de atendimento).
-- Quem se cadastra pelo site é sempre 'comum'; para virar suporte, o perfil
-- é mudado direto no banco:
--   UPDATE usuarios SET perfil = 'suporte' WHERE email = 'email@da.pessoa';
-- ---------------------------------------------------------------------
CREATE TABLE usuarios (
    id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nome       VARCHAR(100) NOT NULL,
    email      VARCHAR(150) NOT NULL UNIQUE,
    senha_hash VARCHAR(255) NOT NULL,
    perfil     VARCHAR(10)  NOT NULL DEFAULT 'comum'
               CHECK (perfil IN ('comum', 'suporte')),
    criado_em  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- TICKETS
-- criado_por aponta para usuarios (chave estrangeira) e é o RESPONSÁVEL pelo
-- ticket: quem o abriu. Quando o suporte abre um ticket em nome de outra
-- pessoa, criado_por é essa pessoa (e o histórico registra quem abriu de fato).
-- O responsável é definido na criação e NÃO muda depois.
-- excluido = TRUE significa "excluído": a linha continua no banco (para
-- preservar o histórico), mas o sistema não mostra mais o ticket.
-- O Postgres NÃO cria índice automático em chave estrangeira, então
-- criei um índice em etapa (usado pelo Kanban) e outro em criado_por
-- (usado no filtro "Meus tickets").
-- ---------------------------------------------------------------------
CREATE TABLE tickets (
    id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    titulo         VARCHAR(150) NOT NULL,
    descricao      TEXT         NOT NULL,
    prioridade     VARCHAR(10)  NOT NULL DEFAULT 'media'
                   CHECK (prioridade IN ('baixa', 'media', 'alta')),
    etapa          VARCHAR(10)  NOT NULL DEFAULT 'backlog'
                   CHECK (etapa IN ('backlog', 'andamento', 'stage', 'concluido')),
    criado_por     INTEGER      NOT NULL REFERENCES usuarios (id),
    excluido       BOOLEAN      NOT NULL DEFAULT FALSE,
    criado_em      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    atualizado_em  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tickets_etapa      ON tickets (etapa);
CREATE INDEX idx_tickets_criado_por ON tickets (criado_por);

-- ---------------------------------------------------------------------
-- HISTÓRICO
-- Cada ação relevante em um ticket vira uma linha aqui.
-- valor_anterior / valor_novo ficam NULL quando não se aplicam. Em mudanças
-- de etapa guardo o NOME da etapa, e em mudanças de prioridade o valor antigo
-- e o novo (uma "foto" do momento). Na criação em nome de outra pessoa,
-- valor_novo guarda o nome dela.
-- ---------------------------------------------------------------------
CREATE TABLE historico (
    id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id      INTEGER      NOT NULL REFERENCES tickets (id),
    usuario_id     INTEGER      NOT NULL REFERENCES usuarios (id),
    acao           VARCHAR(20)  NOT NULL
                   CHECK (acao IN ('criado', 'etapa', 'concluido',
                                   'prioridade', 'editado', 'excluido')),
    valor_anterior VARCHAR(150),
    valor_novo     VARCHAR(150),
    criado_em      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_historico_ticket ON historico (ticket_id);

-- =====================================================================
-- DADOS DE TESTE
-- Senhas de demonstração (cada usuário tem a sua):
--   ana@helpdesk.com    -> h#h2XqPvu9r   (comum)
--   bruno@helpdesk.com  -> m4j@Mzr5xqW   (suporte)
--   carla@helpdesk.com  -> 9Sc#8bdumyG   (suporte)
-- =====================================================================
INSERT INTO usuarios (nome, email, senha_hash, perfil) VALUES
    ('Ana',   'ana@helpdesk.com',   'scrypt:32768:8:1$x2XAw9YrZPP5NTaK$321928e1639a124e4d7f571caf0df17a41764f6f3a05e800ab20a211c6acf9f869e63ac47a66b1979564b12e03a72a97c19c7ebdbf50f7d991295579732d0e96', 'comum'),
    ('Bruno', 'bruno@helpdesk.com', 'scrypt:32768:8:1$b2sRUp8aIMzy3gm1$077e30a319caa86d8d391302e303a4d9c3d12ed11e3822688ca6cab5c46e6c3974c5ed2a3e5ea1f9bcda0247fd360f563669290d76e97130828a9270225d171f', 'suporte'),
    ('Carla', 'carla@helpdesk.com', 'scrypt:32768:8:1$vjPikFMxR2Ssn43x$3820a2d6914aef11d03e6708682915610d9cb3a1aca02e5d52afce43594c9771f7a021e660c3acae623b6631e51e4bc837ec8584a7641cda68874c370b2c7b61', 'suporte');

-- ids dos usuários: 1 = Ana, 2 = Bruno, 3 = Carla
-- As datas são relativas a "agora" (NOW() menos um intervalo), para os exemplos
-- terem horários diferentes e o histórico fazer sentido ao ler.
INSERT INTO tickets (titulo, descricao, prioridade, etapa, criado_por, criado_em, atualizado_em) VALUES
    ('Impressora do financeiro não imprime', 'A impressora do 2º andar mostra erro de papel, mas a bandeja está cheia.', 'media', 'backlog',   1, NOW() - INTERVAL '2 days 4 hours', NOW() - INTERVAL '1 day 22 hours'),
    ('Sistema fora do ar',                   'Ninguém consegue acessar o sistema interno desde as 8h.',                  'alta',  'andamento', 2, NOW() - INTERVAL '1 day 9 hours', NOW() - INTERVAL '1 day 8 hours'),
    ('Trocar mouse da recepção',             'O mouse da recepção está com o botão esquerdo falhando.',                  'baixa', 'stage',     3, NOW() - INTERVAL '3 days 6 hours', NOW() - INTERVAL '1 day 3 hours'),
    ('Criar e-mail para novo funcionário',   'Novo colaborador começa segunda-feira e precisa de e-mail corporativo.',   'media', 'concluido', 1, NOW() - INTERVAL '4 days 5 hours', NOW() - INTERVAL '2 days 18 hours');

-- Histórico coerente com a etapa e o horário de cada ticket.
-- O ticket 4 foi aberto pela Carla (suporte) em nome da Ana.
INSERT INTO historico (ticket_id, usuario_id, acao, valor_anterior, valor_novo, criado_em) VALUES
    (1, 1, 'criado',    NULL,        NULL,        NOW() - INTERVAL '2 days 4 hours'),
    (1, 1, 'editado',   NULL,        NULL,        NOW() - INTERVAL '1 day 22 hours'),
    (2, 2, 'criado',    NULL,        NULL,        NOW() - INTERVAL '1 day 9 hours'),
    (2, 3, 'etapa',     'backlog',   'andamento', NOW() - INTERVAL '1 day 8 hours'),
    (3, 3, 'criado',    NULL,        NULL,        NOW() - INTERVAL '3 days 6 hours'),
    (3, 2, 'etapa',     'backlog',   'andamento', NOW() - INTERVAL '2 days 20 hours'),
    (3, 2, 'etapa',     'andamento', 'stage',     NOW() - INTERVAL '1 day 3 hours'),
    (4, 3, 'criado',    NULL,        'Ana',       NOW() - INTERVAL '4 days 5 hours'),
    (4, 2, 'etapa',     'backlog',   'andamento', NOW() - INTERVAL '3 days 22 hours'),
    (4, 2, 'etapa',     'andamento', 'stage',     NOW() - INTERVAL '3 days 2 hours'),
    (4, 3, 'concluido', 'stage',     'concluido', NOW() - INTERVAL '2 days 18 hours');
