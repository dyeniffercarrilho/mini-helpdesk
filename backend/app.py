"""
Backend do Mini Helpdesk.

Tecnologias: Flask (rotas e sessão) + PostgreSQL (via psycopg).

Este arquivo faz duas coisas:
  1. Entrega os arquivos do frontend (index.html, style.css, app.js).
  2. Oferece a API em /api/... (sempre responde em JSON).

Rotas da API:
  POST   /api/cadastro              cria uma conta (sempre perfil "comum")
  POST   /api/login                 entra no sistema
  POST   /api/logout                sai do sistema
  GET    /api/eu                    dados de quem está logado
  GET    /api/usuarios              lista de usuários (para o filtro e o responsável)
  GET    /api/tickets               lista tickets (aceita filtros na URL)
  POST   /api/tickets               cria ticket
  GET    /api/tickets/<id>          detalhes + histórico + comentários
  PUT    /api/tickets/<id>          edita ticket
  PUT    /api/tickets/<id>/etapa    move o ticket de etapa
  POST   /api/tickets/<id>/comentarios  comenta num ticket
  PUT    /api/comentarios/<id>      edita um comentário (só o autor)
  DELETE /api/comentarios/<id>      exclui (esconde) um comentário
  DELETE /api/tickets/<id>          exclui (esconde) um ticket do Backlog

Variáveis de ambiente necessárias (veja .env.example):
  DATABASE_URL  endereço do banco PostgreSQL
  SECRET_KEY    texto secreto usado para assinar o cookie de sessão
"""

import os
import re

import psycopg
from dotenv import load_dotenv
from flask import Flask, g, jsonify, request, send_from_directory, session
from psycopg.rows import dict_row
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

# Lê o arquivo .env (se existir) e transforma as linhas em variáveis de ambiente.
# Na Vercel não existe .env: as variáveis são configuradas no painel do projeto.
load_dotenv()

PASTA_FRONTEND = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")
)

app = Flask(__name__)

# SECRET_KEY assina o cookie de sessão: sem ela, qualquer pessoa poderia
# forjar um cookie dizendo "sou do suporte". Por isso não existe valor padrão.
app.secret_key = os.environ.get("SECRET_KEY")
if not app.secret_key:
    raise RuntimeError("Defina a variável SECRET_KEY (veja o arquivo .env.example).")

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,    # o JavaScript da página não consegue ler o cookie
    SESSION_COOKIE_SAMESITE="Lax",   # o navegador não envia o cookie em requisições de outros sites
    SESSION_COOKIE_SECURE=bool(os.environ.get("VERCEL")),  # na Vercel (https), só envia por https
)

ETAPAS = ["backlog", "andamento", "stage", "concluido"]
PRIORIDADES = ["baixa", "media", "alta"]

# Para onde um ticket pode ir a partir de cada etapa (nada de pular etapas).
# De "concluido" não se sai: concluído é o fim do fluxo.
PREFIXO_DEVOLUCAO = "Devolvido para Em andamento. Motivo: "

MOVIMENTOS_PERMITIDOS = {
    "backlog": ["andamento"],
    "andamento": ["backlog", "stage"],
    "stage": ["andamento", "concluido"],
    "concluido": [],
}

# Consulta base dos tickets. O JOIN traz o nome de quem criou (o "responsável").
# "excluido = FALSE" esconde os tickets excluídos (exclusão lógica).
SQL_TICKET = """
    SELECT t.id, t.titulo, t.descricao, t.prioridade, t.etapa,
           t.criado_por, c.nome AS criador_nome,
           (SELECT COUNT(*) FROM comentarios k WHERE k.ticket_id = t.id AND k.excluido = FALSE) AS total_comentarios,
           t.criado_em, t.atualizado_em
    FROM tickets t
    JOIN usuarios c ON c.id = t.criado_por
    WHERE t.excluido = FALSE
"""


# ----------------------------------------------------------------------
# Banco de dados
# ----------------------------------------------------------------------
def pegar_conexao():
    """Abre a conexão com o banco uma única vez por requisição."""
    if "conn" not in g:
        # dict_row faz cada linha do banco virar um dicionário: linha["titulo"]
        # prepare_threshold=None desliga os "prepared statements automáticos" do psycopg,
        # que dão problema com o pooler (PgBouncer) que a Neon usa na string de conexão.
        g.conn = psycopg.connect(
            os.environ["DATABASE_URL"], row_factory=dict_row, prepare_threshold=None
        )
    return g.conn


@app.teardown_appcontext
def fechar_conexao(_erro):
    """Roda no fim de toda requisição. Fechar sem commit desfaz (rollback) o que ficou pendente."""
    conn = g.pop("conn", None)
    if conn is not None:
        conn.close()


# ----------------------------------------------------------------------
# Funções auxiliares
# ----------------------------------------------------------------------
def erro(mensagem, status):
    """Resposta de erro padrão: {"erro": "..."} com o código HTTP correspondente."""
    return jsonify({"erro": mensagem}), status


def ler_corpo():
    """
    Lê o JSON enviado pelo navegador.
    Só aceita Content-Type: application/json. Um formulário de outro site não
    consegue enviar esse tipo sem permissão, o que ajuda contra ataques CSRF.
    """
    dados = request.get_json(silent=True)
    return dados if isinstance(dados, dict) else None


def ler_inteiro(valor):
    """Converte para int ou devolve None se não for um número válido."""
    try:
        return int(valor)
    except (TypeError, ValueError):
        return None


def registrar_historico(conn, ticket_id, acao, anterior=None, novo=None):
    """Grava uma linha no histórico. Quem fez a ação é sempre o usuário logado."""
    conn.execute(
        "INSERT INTO historico (ticket_id, usuario_id, acao, valor_anterior, valor_novo) "
        "VALUES (%s, %s, %s, %s, %s)",
        (ticket_id, g.usuario["id"], acao, anterior, novo),
    )


def buscar_ticket(conn, ticket_id):
    return conn.execute(SQL_TICKET + " AND t.id = %s", (ticket_id,)).fetchone()


def buscar_usuario(conn, usuario_id):
    if usuario_id is None:
        return None
    return conn.execute(
        "SELECT id, nome FROM usuarios WHERE id = %s", (usuario_id,)
    ).fetchone()


def validar_campos_do_ticket(dados):
    """Valida título, descrição e prioridade. Devolve (campos, mensagem_de_erro)."""
    titulo = dados.get("titulo")
    descricao = dados.get("descricao")
    prioridade = dados.get("prioridade")

    titulo = titulo.strip() if isinstance(titulo, str) else ""
    descricao = descricao.strip() if isinstance(descricao, str) else ""

    if not titulo or len(titulo) > 150:
        return None, "O título é obrigatório e deve ter até 150 caracteres."
    if not descricao or len(descricao) > 2000:
        return None, "A descrição é obrigatória e deve ter até 2000 caracteres."
    if prioridade not in PRIORIDADES:
        return None, "Escolha uma prioridade válida (baixa, média ou alta)."

    return {"titulo": titulo, "descricao": descricao, "prioridade": prioridade}, None


# ----------------------------------------------------------------------
# Regras de permissão (a decisão final é SEMPRE do backend)
# ----------------------------------------------------------------------
def eh_suporte(usuario):
    """O perfil 'suporte' é o da equipe de atendimento (guardado na coluna usuarios.perfil)."""
    return usuario["perfil"] == "suporte"


def etapas_de_destino(usuario, ticket):
    """
    Para onde ESTE usuário pode mandar o ticket agora.
    - Suporte: as etapas vizinhas (menos em ticket concluído).
    - Quem criou o ticket (comum): só quando ele está em Stage, que é a hora de
      testar: pode concluir (aprovou) ou devolver para Em andamento (reprovou).
    """
    etapa = ticket["etapa"]
    if etapa == "concluido":
        return []
    if eh_suporte(usuario):
        return list(MOVIMENTOS_PERMITIDOS[etapa])
    if etapa == "stage" and ticket["criado_por"] == usuario["id"]:
        return list(MOVIMENTOS_PERMITIDOS[etapa])
    return []


def pode_mover(usuario, ticket):
    """Pode mexer no fluxo se tem pelo menos um destino possível."""
    return len(etapas_de_destino(usuario, ticket)) > 0


def pode_editar(usuario, ticket):
    """Concluído ninguém edita. Suporte edita os demais; comum só o que criou e só no Backlog."""
    if ticket["etapa"] == "concluido":
        return False
    if eh_suporte(usuario):
        return True
    return ticket["criado_por"] == usuario["id"] and ticket["etapa"] == "backlog"


def pode_excluir(usuario, ticket):
    """Vale para todos: só no Backlog. Suporte exclui qualquer um; comum só o que criou."""
    if ticket["etapa"] != "backlog":
        return False
    return eh_suporte(usuario) or ticket["criado_por"] == usuario["id"]


def pode_comentar(usuario, ticket):
    """Qualquer pessoa logada comenta (todos já veem todos os tickets), exceto em ticket concluído."""
    return ticket["etapa"] != "concluido"


def buscar_comentario(conn, comentario_id):
    """Comentário ainda visível, junto da etapa do ticket (que define se ainda dá para mexer nele)."""
    return conn.execute(
        "SELECT k.id, k.usuario_id, k.texto, t.etapa "
        "FROM comentarios k JOIN tickets t ON t.id = k.ticket_id "
        "WHERE k.id = %s AND k.excluido = FALSE AND t.excluido = FALSE",
        (comentario_id,),
    ).fetchone()


def pode_editar_comentario(usuario, comentario):
    """Só o autor edita, e só enquanto o ticket não está concluído."""
    return comentario["usuario_id"] == usuario["id"] and comentario["etapa"] != "concluido"


def pode_excluir_comentario(usuario, comentario):
    """Cada pessoa exclui só os próprios comentários (suporte também), e não em ticket concluído."""
    return comentario["usuario_id"] == usuario["id"] and comentario["etapa"] != "concluido"


def ticket_para_json(ticket, usuario):
    """
    Devolve o ticket com a lista do que ESTE usuário pode fazer nele.
    O frontend usa essas permissões só para mostrar ou esconder botões.
    Quem realmente protege é o backend, que confere de novo em cada ação.
    """
    ticket = dict(ticket)
    destinos = etapas_de_destino(usuario, ticket)
    ticket["permissoes"] = {
        "mover": len(destinos) > 0,
        "destinos": destinos,
        "editar": pode_editar(usuario, ticket),
        "excluir": pode_excluir(usuario, ticket),
        "comentar": pode_comentar(usuario, ticket),
    }
    return ticket


# ----------------------------------------------------------------------
# Antes de toda requisição: exige login (exceto nas rotas públicas)
# ----------------------------------------------------------------------
ROTAS_PUBLICAS = {"pagina_inicial", "arquivo_css", "arquivo_js", "cadastro", "login"}


@app.before_request
def exigir_login():
    """
    Segurança "por padrão": toda rota é protegida, a menos que esteja na lista
    acima. Assim não corremos o risco de esquecer de proteger uma rota nova.
    Se o usuário está logado, deixa os dados dele em g.usuario.
    """
    if request.endpoint in ROTAS_PUBLICAS:
        return None

    usuario = None
    usuario_id = session.get("usuario_id")
    if usuario_id is not None:
        # Busca no banco a cada requisição: se o perfil mudar, vale na hora.
        usuario = pegar_conexao().execute(
            "SELECT id, nome, email, perfil FROM usuarios WHERE id = %s", (usuario_id,)
        ).fetchone()

    if usuario is None:
        return erro("Faça login para continuar.", 401)
    g.usuario = usuario
    return None


@app.errorhandler(Exception)
def tratar_erros(e):
    """Garante que até os erros inesperados voltem em JSON (e não em HTML)."""
    if isinstance(e, HTTPException):
        return erro(e.description, e.code)
    app.logger.exception(e)
    return erro("Erro interno do servidor.", 500)


# ----------------------------------------------------------------------
# Arquivos do frontend
# ----------------------------------------------------------------------
@app.get("/")
def pagina_inicial():
    return send_from_directory(PASTA_FRONTEND, "index.html")


@app.get("/style.css")
def arquivo_css():
    return send_from_directory(PASTA_FRONTEND, "style.css")


@app.get("/app.js")
def arquivo_js():
    return send_from_directory(PASTA_FRONTEND, "app.js")


# ----------------------------------------------------------------------
# Autenticação
# ----------------------------------------------------------------------
@app.post("/api/cadastro")
def cadastro():
    dados = ler_corpo()
    if dados is None:
        return erro("Envie os dados em JSON.", 400)

    nome = dados.get("nome")
    email = dados.get("email")
    senha = dados.get("senha")
    nome = nome.strip() if isinstance(nome, str) else ""
    email = email.strip().lower() if isinstance(email, str) else ""

    if len(nome) < 2 or len(nome) > 100:
        return erro("O nome deve ter entre 2 e 100 caracteres.", 400)
    if len(email) > 150 or not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        return erro("Digite um e-mail válido.", 400)
    if not isinstance(senha, str) or len(senha) < 8 or len(senha) > 128:
        return erro("A senha deve ter entre 8 e 128 caracteres.", 400)

    conn = pegar_conexao()
    try:
        # generate_password_hash cria um hash com "sal": a senha em si nunca é salva.
        conn.execute(
            "INSERT INTO usuarios (nome, email, senha_hash) VALUES (%s, %s, %s)",
            (nome, email, generate_password_hash(senha)),
        )
        conn.commit()
    except psycopg.errors.UniqueViolation:
        # A regra UNIQUE do banco impede e-mails repetidos.
        return erro("Já existe uma conta com esse e-mail.", 409)

    return jsonify({"ok": True}), 201


@app.post("/api/login")
def login():
    dados = ler_corpo()
    if dados is None:
        return erro("Envie os dados em JSON.", 400)

    email = dados.get("email")
    senha = dados.get("senha")
    if not isinstance(email, str) or not isinstance(senha, str):
        return erro("Informe e-mail e senha.", 400)

    usuario = pegar_conexao().execute(
        "SELECT id, nome, email, perfil, senha_hash FROM usuarios WHERE email = %s",
        (email.strip().lower(),),
    ).fetchone()

    # A mesma mensagem para "e-mail não existe" e "senha errada":
    # assim ninguém descobre quais e-mails estão cadastrados.
    if usuario is None or not check_password_hash(usuario["senha_hash"], senha):
        return erro("E-mail ou senha incorretos.", 401)

    session.clear()
    session["usuario_id"] = usuario["id"]  # o cookie guarda só o id, assinado
    return jsonify({
        "usuario": {"id": usuario["id"], "nome": usuario["nome"],
                    "email": usuario["email"], "perfil": usuario["perfil"]}
    })


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/eu")
def eu():
    return jsonify({"usuario": g.usuario})


@app.get("/api/usuarios")
def listar_usuarios():
    # Só id e nome: e-mail e perfil dos outros não precisam ser expostos.
    usuarios = pegar_conexao().execute(
        "SELECT id, nome FROM usuarios ORDER BY nome"
    ).fetchall()
    return jsonify({"usuarios": usuarios})


# ----------------------------------------------------------------------
# Tickets
# ----------------------------------------------------------------------
@app.get("/api/tickets")
def listar_tickets():
    """Filtros opcionais na URL: ?meus=1&prioridade=alta&criado_por=3&busca=texto"""
    filtros = ""
    parametros = []

    # Os trechos de SQL abaixo são fixos (escritos por nós). O que vem do
    # navegador entra SEMPRE pelos %s, nunca colado no texto do SQL.
    if request.args.get("meus") == "1":
        filtros += " AND t.criado_por = %s"
        parametros.append(g.usuario["id"])

    prioridade = request.args.get("prioridade")
    if prioridade in PRIORIDADES:
        filtros += " AND t.prioridade = %s"
        parametros.append(prioridade)

    criador = ler_inteiro(request.args.get("criado_por"))
    if criador is not None:
        filtros += " AND t.criado_por = %s"
        parametros.append(criador)

    busca = request.args.get("busca", "").strip()[:100]
    if busca:
        filtros += " AND (t.titulo ILIKE %s OR t.descricao ILIKE %s)"
        parametros += [f"%{busca}%", f"%{busca}%"]

    # Prioridade alta primeiro; dentro dela, os mais recentemente atualizados.
    ordem = """ ORDER BY CASE t.prioridade WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END,
               t.atualizado_em DESC"""

    tickets = pegar_conexao().execute(SQL_TICKET + filtros + ordem, parametros).fetchall()
    return jsonify({"tickets": [ticket_para_json(t, g.usuario) for t in tickets]})


@app.post("/api/tickets")
def criar_ticket():
    dados = ler_corpo()
    if dados is None:
        return erro("Envie os dados em JSON.", 400)

    campos, mensagem = validar_campos_do_ticket(dados)
    if mensagem:
        return erro(mensagem, 400)

    conn = pegar_conexao()

    # O responsável é quem cria o ticket. Só o suporte pode abrir em nome de
    # outra pessoa (campo responsavel_id); para usuário comum esse campo é ignorado.
    dono = g.usuario
    if eh_suporte(g.usuario) and dados.get("responsavel_id") not in (None, ""):
        dono = buscar_usuario(conn, ler_inteiro(dados.get("responsavel_id")))
        if dono is None:
            return erro("Escolha um responsável válido.", 400)

    # TRANSAÇÃO: criar o ticket e gravar o histórico andam juntos.
    # Se algo falhar no meio, nada fica salvo (o commit só acontece no fim).
    # A etapa não vem do navegador: todo ticket novo começa no Backlog (padrão do banco).
    novo = conn.execute(
        "INSERT INTO tickets (titulo, descricao, prioridade, criado_por) "
        "VALUES (%s, %s, %s, %s) RETURNING id",
        (campos["titulo"], campos["descricao"], campos["prioridade"], dono["id"]),
    ).fetchone()
    # Se o suporte abriu em nome de outra pessoa, o histórico guarda o nome dela.
    em_nome_de = dono["nome"] if dono["id"] != g.usuario["id"] else None
    registrar_historico(conn, novo["id"], "criado", None, em_nome_de)
    conn.commit()

    return jsonify({"ok": True, "id": novo["id"]}), 201


@app.get("/api/tickets/<int:ticket_id>")
def detalhe_ticket(ticket_id):
    conn = pegar_conexao()
    ticket = buscar_ticket(conn, ticket_id)
    if ticket is None:
        return erro("Ticket não encontrado.", 404)

    historico = conn.execute(
        "SELECT h.id, h.acao, h.valor_anterior, h.valor_novo, h.criado_em, "
        "       u.nome AS usuario_nome "
        "FROM historico h JOIN usuarios u ON u.id = h.usuario_id "
        "WHERE h.ticket_id = %s ORDER BY h.id DESC",
        (ticket_id,),
    ).fetchall()

    # Comentários do mais antigo para o mais novo (como numa conversa)
    comentarios = conn.execute(
        "SELECT k.id, k.usuario_id, k.texto, k.criado_em, k.editado_em, "
        "       u.nome AS usuario_nome "
        "FROM comentarios k JOIN usuarios u ON u.id = k.usuario_id "
        "WHERE k.ticket_id = %s AND k.excluido = FALSE ORDER BY k.id",
        (ticket_id,),
    ).fetchall()
    # Diz a cada comentário o que ESTE usuário pode fazer nele (o frontend só mostra/esconde o menu)
    for comentario in comentarios:
        dados_para_regra = {"usuario_id": comentario.pop("usuario_id"), "etapa": ticket["etapa"]}
        comentario["permissoes"] = {
            "editar": pode_editar_comentario(g.usuario, dados_para_regra),
            "excluir": pode_excluir_comentario(g.usuario, dados_para_regra),
        }

    return jsonify({"ticket": ticket_para_json(ticket, g.usuario),
                    "historico": historico, "comentarios": comentarios})


@app.put("/api/tickets/<int:ticket_id>")
def editar_ticket(ticket_id):
    conn = pegar_conexao()
    ticket = buscar_ticket(conn, ticket_id)
    if ticket is None:
        return erro("Ticket não encontrado.", 404)
    if not pode_editar(g.usuario, ticket):
        return erro("Você não tem permissão para editar este ticket.", 403)

    dados = ler_corpo()
    if dados is None:
        return erro("Envie os dados em JSON.", 400)
    campos, mensagem = validar_campos_do_ticket(dados)
    if mensagem:
        return erro(mensagem, 400)

    # Quem criou (o responsável) NÃO muda depois: o UPDATE abaixo não toca em
    # criado_por, mesmo que o navegador envie esse campo.

    # TRANSAÇÃO: o UPDATE e as linhas de histórico são salvos juntos ou nenhum.
    conn.execute(
        "UPDATE tickets SET titulo = %s, descricao = %s, prioridade = %s, "
        "atualizado_em = NOW() WHERE id = %s",
        (campos["titulo"], campos["descricao"], campos["prioridade"], ticket_id),
    )
    if campos["titulo"] != ticket["titulo"] or campos["descricao"] != ticket["descricao"]:
        registrar_historico(conn, ticket_id, "editado")
    if campos["prioridade"] != ticket["prioridade"]:
        registrar_historico(conn, ticket_id, "prioridade", ticket["prioridade"], campos["prioridade"])
    conn.commit()

    return jsonify({"ok": True})


@app.put("/api/tickets/<int:ticket_id>/etapa")
def mover_ticket(ticket_id):
    conn = pegar_conexao()
    ticket = buscar_ticket(conn, ticket_id)
    if ticket is None:
        return erro("Ticket não encontrado.", 404)
    etapa_atual = ticket["etapa"]
    if etapa_atual == "concluido":
        return erro("Ticket concluído não pode mais ser movido.", 400)
    if not pode_mover(g.usuario, ticket):
        if eh_suporte(g.usuario):
            return erro("Você não pode mover este ticket.", 403)
        return erro("Você só pode mover os seus tickets, e só quando estiverem em Stage.", 403)

    dados = ler_corpo()
    nova_etapa = dados.get("etapa") if dados else None
    if nova_etapa not in ETAPAS:
        return erro("Etapa inválida.", 400)

    if nova_etapa == etapa_atual:
        return erro("O ticket já está nessa etapa.", 400)
    if nova_etapa not in MOVIMENTOS_PERMITIDOS[etapa_atual]:
        return erro("Movimento não permitido: não é possível pular etapas.", 400)
    if nova_etapa not in etapas_de_destino(g.usuario, ticket):
        return erro("Você não tem permissão para esse movimento.", 403)

    # Devolver de Stage para Em andamento exige o motivo (vira um comentário do ticket).
    texto_motivo = None
    if etapa_atual == "stage" and nova_etapa == "andamento":
        motivo = dados.get("motivo")
        motivo = motivo.strip() if isinstance(motivo, str) else ""
        if not motivo:
            return erro("Explique o motivo da devolução.", 400)
        texto_motivo = PREFIXO_DEVOLUCAO + motivo
        if len(texto_motivo) > 1000:
            return erro("O motivo está longo demais. Resuma um pouco.", 400)

    # TRANSAÇÃO: atualizar a etapa + gravar no histórico.
    # "AND etapa = etapa_atual" evita conflito: se outra pessoa moveu o ticket
    # no meio-tempo, o UPDATE não encontra nenhuma linha e avisamos o usuário.
    atualizado = conn.execute(
        "UPDATE tickets SET etapa = %s, atualizado_em = NOW() WHERE id = %s AND etapa = %s",
        (nova_etapa, ticket_id, etapa_atual),
    )
    if atualizado.rowcount == 0:
        return erro("Este ticket foi alterado por outra pessoa. Recarregue a página.", 409)

    acao = "concluido" if nova_etapa == "concluido" else "etapa"
    registrar_historico(conn, ticket_id, acao, etapa_atual, nova_etapa)
    if texto_motivo:
        conn.execute(
            "INSERT INTO comentarios (ticket_id, usuario_id, texto) VALUES (%s, %s, %s)",
            (ticket_id, g.usuario["id"], texto_motivo),
        )
    conn.commit()

    return jsonify({"ok": True})


@app.post("/api/tickets/<int:ticket_id>/comentarios")
def comentar_ticket(ticket_id):
    conn = pegar_conexao()
    ticket = buscar_ticket(conn, ticket_id)
    if ticket is None:
        return erro("Ticket não encontrado.", 404)
    if not pode_comentar(g.usuario, ticket):
        return erro("Ticket concluído não recebe mais comentários.", 403)

    dados = ler_corpo()
    if dados is None:
        return erro("Envie os dados em JSON.", 400)
    texto = dados.get("texto")
    texto = texto.strip() if isinstance(texto, str) else ""
    if not texto or len(texto) > 1000:
        return erro("O comentário é obrigatório e deve ter até 1000 caracteres.", 400)

    # Quem comentou é sempre o usuário logado (nunca vem do navegador).
    conn.execute(
        "INSERT INTO comentarios (ticket_id, usuario_id, texto) VALUES (%s, %s, %s)",
        (ticket_id, g.usuario["id"], texto),
    )
    conn.commit()
    return jsonify({"ok": True}), 201


@app.put("/api/comentarios/<int:comentario_id>")
def editar_comentario(comentario_id):
    conn = pegar_conexao()
    comentario = buscar_comentario(conn, comentario_id)
    if comentario is None:
        return erro("Comentário não encontrado.", 404)
    if not pode_editar_comentario(g.usuario, comentario):
        return erro("Só o autor pode editar o comentário (e não em ticket concluído).", 403)

    dados = ler_corpo()
    if dados is None:
        return erro("Envie os dados em JSON.", 400)
    texto = dados.get("texto")
    texto = texto.strip() if isinstance(texto, str) else ""
    if not texto or len(texto) > 1000:
        return erro("O comentário é obrigatório e deve ter até 1000 caracteres.", 400)

    # Texto igual ao que já estava: não conta como edição (não aparece "editado")
    if texto != comentario["texto"]:
        conn.execute(
            "UPDATE comentarios SET texto = %s, editado_em = NOW() WHERE id = %s",
            (texto, comentario_id),
        )
        conn.commit()
    return jsonify({"ok": True})


@app.delete("/api/comentarios/<int:comentario_id>")
def excluir_comentario(comentario_id):
    conn = pegar_conexao()
    comentario = buscar_comentario(conn, comentario_id)
    if comentario is None:
        return erro("Comentário não encontrado.", 404)
    if not pode_excluir_comentario(g.usuario, comentario):
        return erro("Só o autor pode excluir o comentário (e não em ticket concluído).", 403)

    # Exclusão lógica: a linha continua no banco, só deixa de aparecer.
    conn.execute("UPDATE comentarios SET excluido = TRUE WHERE id = %s", (comentario_id,))
    conn.commit()
    return jsonify({"ok": True})


@app.delete("/api/tickets/<int:ticket_id>")
def excluir_ticket(ticket_id):
    conn = pegar_conexao()
    ticket = buscar_ticket(conn, ticket_id)
    if ticket is None:
        return erro("Ticket não encontrado.", 404)
    if not pode_excluir(g.usuario, ticket):
        return erro("Só é possível excluir tickets do Backlog, e apenas o criador ou alguém do suporte.", 403)

    # Exclusão lógica: a linha continua no banco (com o histórico), só deixa de aparecer.
    atualizado = conn.execute(
        "UPDATE tickets SET excluido = TRUE, atualizado_em = NOW() "
        "WHERE id = %s AND etapa = 'backlog'",
        (ticket_id,),
    )
    if atualizado.rowcount == 0:
        return erro("Este ticket foi alterado por outra pessoa. Recarregue a página.", 409)

    registrar_historico(conn, ticket_id, "excluido")
    conn.commit()

    return jsonify({"ok": True})


# Só roda quando você executa "python backend/app.py" (desenvolvimento local).
# Na Vercel, quem importa o "app" é a própria Vercel.
if __name__ == "__main__":
    app.run(port=8000, debug=True)
