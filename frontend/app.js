/* =====================================================================
   Mini Helpdesk - JavaScript do frontend (JavaScript puro, sem bibliotecas)

   Organização do arquivo:
     1) Dados e referências aos elementos da página
     2) Funções auxiliares (API, mensagens, confirmação, datas)
     3) Telas: login, cadastro e navegação
     4) Kanban: carregar e desenhar os tickets
     5) Detalhes do ticket e ações (mover, excluir)
     6) Criar e editar ticket
     7) Início do programa

   SEGURANÇA (XSS): tudo que vem do banco (título, descrição, nomes) é colocado
   na página com "textContent", que trata o valor como TEXTO. Nunca usamos
   "innerHTML" com dados de usuário, senão alguém poderia cadastrar um título
   com <script> e rodar código no navegador dos outros.
   ===================================================================== */


/* ---------- 1) Dados e referências aos elementos ---------- */

// Quem está logado (preenchido depois do login)
let usuarioAtual = null;

// Estado da tela
let mostrarSoMeus = false;   // false = "Todos os tickets", true = "Meus tickets"
let ticketAbertoId = null;   // id do ticket que está aberto na janela de detalhes
let ticketEditandoId = null; // id do ticket sendo editado (null = criando um novo)

// Nomes bonitos para mostrar na tela
const NOMES_ETAPAS = {
    backlog: "Backlog",
    andamento: "Em andamento",
    stage: "Stage",
    concluido: "Concluído",
};

// Prioridade: texto + símbolo (a cor sozinha não basta para comunicar)
const NOMES_PRIORIDADES = {
    alta: "▲ Alta",
    media: "● Média",
    baixa: "▼ Baixa",
};

// Para onde cada etapa pode ir (as mesmas regras do backend; aqui servem
// só para decidir quais botões mostrar. Quem decide de verdade é o backend.)
const VOLTAR = { andamento: "backlog", stage: "andamento" };
const AVANCAR = { backlog: "andamento", andamento: "stage", stage: "concluido" };

// Elementos da página (buscados uma vez só)
const cabecalho = document.getElementById("cabecalho");
const telaLogin = document.getElementById("tela-login");
const telaCadastro = document.getElementById("tela-cadastro");
const telaKanban = document.getElementById("tela-kanban");

const dialogTicket = document.getElementById("dialog-ticket");
const dialogDetalhe = document.getElementById("dialog-detalhe");
const dialogConfirmar = document.getElementById("dialog-confirmar");
const caixaMensagem = document.getElementById("mensagem");


/* ---------- 2) Funções auxiliares ---------- */

// Conversa com o backend usando fetch().
// Devolve sempre { ok, dados }: ok é true se o status foi 2xx e
// dados é o JSON da resposta. Assim quem chama não precisa repetir try/catch.
async function chamarApi(url, metodo = "GET", corpo = null) {
    const opcoes = { method: metodo, headers: {} };
    if (corpo !== null) {
        opcoes.headers["Content-Type"] = "application/json";
        opcoes.body = JSON.stringify(corpo);
    }

    try {
        const resposta = await fetch(url, opcoes);
        const dados = await resposta.json();

        // Sessão expirada: só vale se havia alguém logado. (Na abertura da página
        // e na tentativa de login, o 401 é esperado e tratado por quem chamou.)
        if (resposta.status === 401 && usuarioAtual !== null) {
            usuarioAtual = null;
            mostrarTela("login");
            mostrarMensagem("Sua sessão expirou. Entre novamente.", "erro");
        }
        return { ok: resposta.ok, dados: dados };
    } catch (erroDeRede) {
        return { ok: false, dados: { erro: "Não foi possível conectar ao servidor." } };
    }
}

// Mostra um aviso no canto da tela por 4 segundos. tipo: "sucesso" ou "erro".
let temporizadorMensagem = null;
function mostrarMensagem(texto, tipo) {
    caixaMensagem.textContent = texto;
    caixaMensagem.className = tipo;
    if (caixaMensagem.matches(":popover-open")) {
        caixaMensagem.hidePopover();
    }
    caixaMensagem.showPopover(); // popover = camada acima de tudo, até de janelas abertas

    clearTimeout(temporizadorMensagem);
    temporizadorMensagem = setTimeout(function () {
        if (caixaMensagem.matches(":popover-open")) {
            caixaMensagem.hidePopover();
        }
    }, 4000);
}

// Pergunta "tem certeza?" numa janela. Devolve true (confirmou) ou false.
// Uso:  if (await confirmar("Título", "Texto", "Botão")) { ... }
function confirmar(titulo, texto, textoBotao, perigoso = false) {
    document.getElementById("confirmar-titulo").textContent = titulo;
    document.getElementById("confirmar-texto").textContent = texto;

    const botaoOk = document.getElementById("confirmar-ok");
    botaoOk.textContent = textoBotao;
    botaoOk.className = perigoso ? "perigo" : "";

    dialogConfirmar.returnValue = "";
    dialogConfirmar.showModal();

    // Espera a janela fechar. O form method="dialog" guarda o "value" do botão clicado.
    return new Promise(function (resolver) {
        dialogConfirmar.addEventListener("close", function () {
            resolver(dialogConfirmar.returnValue === "ok");
        }, { once: true });
    });
}

// Formata a data que vem do servidor: "02/10/2026 17:45"
function formatarData(texto) {
    return new Date(texto).toLocaleString("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
    });
}

// Preenche um <select> com a lista de usuários.
// "primeiraOpcao" é o texto da opção vazia (ex.: "Todos"); use null para não ter.
function preencherSelectDeUsuarios(select, usuarios, primeiraOpcao) {
    select.replaceChildren(); // limpa as opções antigas
    if (primeiraOpcao !== null) {
        const vazia = document.createElement("option");
        vazia.value = "";
        vazia.textContent = primeiraOpcao;
        select.appendChild(vazia);
    }
    for (const usuario of usuarios) {
        const opcao = document.createElement("option");
        opcao.value = usuario.id;
        opcao.textContent = usuario.nome;
        select.appendChild(opcao);
    }
}

// Coloca o selo de prioridade (cor + símbolo + texto) dentro de um <span>
function configurarSeloPrioridade(elemento, prioridade) {
    elemento.className = "prioridade prioridade-" + prioridade;
    elemento.textContent = NOMES_PRIORIDADES[prioridade];
}


/* ---------- 3) Telas: login, cadastro e navegação ---------- */

// Mostra uma tela e esconde as outras. nome: "login", "cadastro" ou "kanban"
function mostrarTela(nome) {
    document.getElementById("login-erro").hidden = true; // não deixa erro antigo "preso" no login
    telaLogin.hidden = nome !== "login";
    telaCadastro.hidden = nome !== "cadastro";
    telaKanban.hidden = nome !== "kanban";
    cabecalho.hidden = nome !== "kanban"; // o cabeçalho só existe logado

    // Se voltou para o login, fecha qualquer janela que estivesse aberta
    if (nome !== "kanban") {
        dialogTicket.close();
        dialogDetalhe.close();
        dialogConfirmar.close();
    }
}

// Botões "Cadastre-se" e "Entrar" (trocam entre login e cadastro)
for (const botao of document.querySelectorAll("[data-ir-para]")) {
    botao.addEventListener("click", function () {
        mostrarTela(botao.dataset.irPara);
    });
}

// Depois do login (ou ao reabrir a página já logado): prepara a tela principal
async function entrarNoSistema(usuario) {
    usuarioAtual = usuario;

    document.getElementById("usuario-nome").textContent = usuario.nome;
    document.getElementById("usuario-perfil").textContent =
        usuario.perfil === "suporte" ? "Suporte" : "Usuário";

    mostrarTela("kanban");

    // A lista de usuários alimenta os selects de responsável (filtro e formulário)
    const resposta = await chamarApi("/api/usuarios");
    if (resposta.ok) {
        preencherSelectDeUsuarios(
            document.getElementById("filtro-criador"), resposta.dados.usuarios, "Todos");
        preencherSelectDeUsuarios(
            document.getElementById("ticket-responsavel"), resposta.dados.usuarios, null);
    }

    await carregarTickets();
}

// --- Formulário de login ---
document.getElementById("form-login").addEventListener("submit", async function (evento) {
    evento.preventDefault(); // impede a página de recarregar
    const botao = document.getElementById("btn-login");
    const erroLogin = document.getElementById("login-erro");
    erroLogin.hidden = true; // esconde o erro da tentativa anterior

    botao.disabled = true;           // estado de "carregando": evita clique duplo
    botao.textContent = "Entrando...";

    const resposta = await chamarApi("/api/login", "POST", {
        email: document.getElementById("login-email").value,
        senha: document.getElementById("login-senha").value,
    });

    botao.disabled = false;
    botao.textContent = "Entrar";

    if (!resposta.ok) {
        // O erro do login aparece dentro do formulário (e não no aviso do canto da tela)
        erroLogin.textContent = resposta.dados.erro;
        erroLogin.hidden = false;
        return;
    }
    document.getElementById("login-senha").value = ""; // não deixa a senha na tela
    await entrarNoSistema(resposta.dados.usuario);
});

// --- Formulário de cadastro ---
document.getElementById("form-cadastro").addEventListener("submit", async function (evento) {
    evento.preventDefault();
    const botao = document.getElementById("btn-cadastro");

    botao.disabled = true;
    botao.textContent = "Criando...";

    const resposta = await chamarApi("/api/cadastro", "POST", {
        nome: document.getElementById("cadastro-nome").value,
        email: document.getElementById("cadastro-email").value,
        senha: document.getElementById("cadastro-senha").value,
    });

    botao.disabled = false;
    botao.textContent = "Criar conta";

    if (!resposta.ok) {
        mostrarMensagem(resposta.dados.erro, "erro");
        return;
    }
    document.getElementById("form-cadastro").reset();
    mostrarTela("login");
    mostrarMensagem("Conta criada! Agora é só entrar.", "sucesso");
});

// --- Sair ---
document.getElementById("btn-sair").addEventListener("click", async function () {
    await chamarApi("/api/logout", "POST");
    usuarioAtual = null;
    mostrarTela("login");
});


/* ---------- 4) Kanban: carregar e desenhar os tickets ---------- */

// Pede os tickets ao backend (com os filtros escolhidos) e desenha o Kanban
async function carregarTickets() {
    // URLSearchParams monta "?busca=abc&prioridade=alta" já com os caracteres especiais codificados
    const parametros = new URLSearchParams();
    if (mostrarSoMeus) {
        parametros.set("meus", "1");
    }
    const busca = document.getElementById("filtro-busca").value.trim();
    const prioridade = document.getElementById("filtro-prioridade").value;
    const criador = document.getElementById("filtro-criador").value;
    if (busca) parametros.set("busca", busca);
    if (prioridade) parametros.set("prioridade", prioridade);
    if (criador) parametros.set("criado_por", criador);

    const resposta = await chamarApi("/api/tickets?" + parametros.toString());
    if (!resposta.ok) {
        mostrarMensagem(resposta.dados.erro, "erro");
        return;
    }
    desenharKanban(resposta.dados.tickets);
}

// Distribui os tickets nas quatro colunas
function desenharKanban(tickets) {
    for (const etapa of Object.keys(NOMES_ETAPAS)) {
        const coluna = document.getElementById("cards-" + etapa);
        coluna.replaceChildren(); // esvazia a coluna

        // Só os tickets desta etapa (o backend já mandou na ordem: prioridade alta primeiro)
        const daEtapa = tickets.filter(function (ticket) {
            return ticket.etapa === etapa;
        });

        document.getElementById("contador-" + etapa).textContent = daEtapa.length;

        if (daEtapa.length === 0) {
            const aviso = document.createElement("p");
            aviso.className = "vazio";
            aviso.textContent = "Nenhum ticket";
            coluna.appendChild(aviso);
        }
        for (const ticket of daEtapa) {
            coluna.appendChild(criarCard(ticket));
        }
    }
}

// Cria o card de um ticket: #ID, prioridade, título e responsável
function criarCard(ticket) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "card";

    const topo = document.createElement("span");
    topo.className = "card-topo";

    const id = document.createElement("span");
    id.className = "card-id";
    id.textContent = "#" + ticket.id;

    const prioridade = document.createElement("span");
    configurarSeloPrioridade(prioridade, ticket.prioridade);

    topo.append(id, prioridade);

    const titulo = document.createElement("span");
    titulo.className = "card-titulo";
    titulo.textContent = ticket.titulo;

    const criador = document.createElement("span");
    criador.className = "card-criador";
    criador.textContent = "Criado por: " + ticket.criador_nome;

    card.append(topo, titulo, criador);

    card.addEventListener("click", function () {
        abrirDetalhe(ticket.id);
    });
    return card;
}

// --- Abas "Meus tickets" / "Todos os tickets" ---
function escolherAba(soMeus) {
    mostrarSoMeus = soMeus;
    document.getElementById("aba-meus").setAttribute("aria-pressed", String(soMeus));
    document.getElementById("aba-todos").setAttribute("aria-pressed", String(!soMeus));
    carregarTickets();
}
document.getElementById("aba-meus").addEventListener("click", function () {
    escolherAba(true);
});
document.getElementById("aba-todos").addEventListener("click", function () {
    escolherAba(false);
});

// --- Filtros ---
document.getElementById("form-filtros").addEventListener("submit", function (evento) {
    evento.preventDefault();
    carregarTickets();
});
document.getElementById("btn-limpar-filtros").addEventListener("click", function () {
    document.getElementById("form-filtros").reset();
    carregarTickets();
});


/* ---------- 5) Detalhes do ticket e ações ---------- */

// Busca o ticket + histórico e preenche a janela de detalhes
async function abrirDetalhe(id) {
    const resposta = await chamarApi("/api/tickets/" + id);
    if (!resposta.ok) {
        mostrarMensagem(resposta.dados.erro, "erro");
        carregarTickets(); // talvez o ticket tenha sido excluído por outra pessoa
        return;
    }

    const ticket = resposta.dados.ticket;
    ticketAbertoId = ticket.id;

    document.getElementById("detalhe-titulo").textContent = "#" + ticket.id + " · " + ticket.titulo;
    configurarSeloPrioridade(document.getElementById("detalhe-prioridade"), ticket.prioridade);
    document.getElementById("detalhe-etapa").textContent = NOMES_ETAPAS[ticket.etapa];
    document.getElementById("detalhe-descricao").textContent = ticket.descricao;
    document.getElementById("detalhe-criador").textContent = ticket.criador_nome;
    document.getElementById("detalhe-criado-em").textContent = formatarData(ticket.criado_em);
    document.getElementById("detalhe-atualizado-em").textContent = formatarData(ticket.atualizado_em);

    desenharAcoes(ticket);
    desenharHistorico(resposta.dados.historico);

    if (!dialogDetalhe.open) {
        dialogDetalhe.showModal();
    }
}

// Cria um botão de ação e já liga o clique a uma função
// Ícones em SVG (traços simples). São textos fixos escritos por nós, não vêm do usuário,
// por isso é seguro usar innerHTML aqui.
const ICONES = {
    lapis: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    lixeira: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    fechar: '<path d="M18 6 6 18"/><path d="M6 6l12 12"/>',
};

// Troca o texto do botão por um ícone. O "rotulo" vira aria-label (leitor de tela)
// e title (dica ao passar o mouse), já que o botão fica sem texto visível.
function colocarIcone(botao, nomeDoIcone, rotulo) {
    botao.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        ICONES[nomeDoIcone] + '</svg>';
    botao.setAttribute("aria-label", rotulo);
    botao.title = rotulo;
    botao.classList.add("icone");
}

function criarBotaoAcao(texto, classe, aoClicar, icone) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = classe;
    botao.textContent = texto;
    if (icone) colocarIcone(botao, icone, texto);
    botao.addEventListener("click", async function () {
        botao.disabled = true;  // evita clique duplo enquanto a ação roda
        await aoClicar();
        botao.disabled = false;
    });
    return botao;
}

// Mostra só os botões que ESTE usuário pode usar (ticket.permissoes veio do backend).
// Lembrete: esconder botão é só conforto visual. O backend confere tudo de novo.
function desenharAcoes(ticket) {
    const area = document.getElementById("detalhe-acoes");
    area.replaceChildren();
    // Editar e excluir ficam no canto de cima, ao lado do X; embaixo ficam só as ações do fluxo
    const areaTopo = document.getElementById("detalhe-acoes-topo");
    areaTopo.replaceChildren();

    if (ticket.permissoes.mover) {
        const anterior = VOLTAR[ticket.etapa];
        const proxima = AVANCAR[ticket.etapa];

        if (anterior) {
            area.appendChild(criarBotaoAcao("← Voltar para " + NOMES_ETAPAS[anterior], "secundario",
                function () { return moverTicket(ticket, anterior); }));
        }
        if (proxima) {
            const texto = proxima === "concluido" ? "Concluir ticket" : "Avançar para " + NOMES_ETAPAS[proxima];
            area.appendChild(criarBotaoAcao(texto, "",
                function () { return moverTicket(ticket, proxima); }));
        }
    }
    if (ticket.permissoes.editar) {
        areaTopo.appendChild(criarBotaoAcao("Editar ticket", "secundario",
            function () { abrirFormularioEditar(ticket); }, "lapis"));
    }
    if (ticket.permissoes.excluir) {
        areaTopo.appendChild(criarBotaoAcao("Excluir ticket", "perigo",
            function () { return excluirTicket(ticket); }, "lixeira"));
    }
}

// Move o ticket. Só concluir pede confirmação (é a ação de maior impacto do fluxo).
async function moverTicket(ticket, novaEtapa) {
    if (novaEtapa === "concluido") {
        const confirmou = await confirmar(
            "Concluir ticket?",
            "Após a conclusão, o ticket não poderá mais ser movido nem editado.",
            "Concluir");
        if (!confirmou) return;
    }

    const resposta = await chamarApi("/api/tickets/" + ticket.id + "/etapa", "PUT", { etapa: novaEtapa });
    if (!resposta.ok) {
        mostrarMensagem(resposta.dados.erro, "erro");
        return;
    }
    mostrarMensagem("Ticket movido para " + NOMES_ETAPAS[novaEtapa] + ".", "sucesso");
    await atualizarTela();
}

async function excluirTicket(ticket) {
    const confirmou = await confirmar(
        "Excluir ticket?",
        "O ticket deixará de aparecer no sistema. Esta ação não pode ser desfeita por aqui.",
        "Excluir",
        true);
    if (!confirmou) return;

    const resposta = await chamarApi("/api/tickets/" + ticket.id, "DELETE");
    if (!resposta.ok) {
        mostrarMensagem(resposta.dados.erro, "erro");
        return;
    }
    dialogDetalhe.close();
    mostrarMensagem("Ticket excluído.", "sucesso");
    await carregarTickets();
}

// Depois de qualquer mudança: recarrega o Kanban e, se a janela de detalhes
// estiver aberta, recarrega ela também.
async function atualizarTela() {
    await carregarTickets();
    if (dialogDetalhe.open) {
        await abrirDetalhe(ticketAbertoId);
    }
}

// Monta a frase de cada registro do histórico
function textoDoHistorico(registro) {
    const de = registro.valor_anterior;
    const para = registro.valor_novo;

    switch (registro.acao) {
        case "criado":
            // valor_novo guarda o nome da pessoa quando o suporte abriu em nome dela
            return para ? "criou o ticket em nome de " + para : "criou o ticket";
        case "etapa":
            return "moveu de " + NOMES_ETAPAS[de] + " para " + NOMES_ETAPAS[para];
        case "concluido":
            return "concluiu o ticket";
        case "prioridade":
            return "alterou a prioridade de " + NOMES_PRIORIDADES[de] + " para " + NOMES_PRIORIDADES[para];
        case "editado":
            return "editou o título ou a descrição";
        case "excluido":
            return "excluiu o ticket";
        default:
            return registro.acao;
    }
}

// Desenha o histórico como uma linha do tempo (mais recente primeiro)
function desenharHistorico(historico) {
    const lista = document.getElementById("lista-historico");
    lista.replaceChildren();

    for (const registro of historico) {
        const item = document.createElement("li");

        const quem = document.createElement("strong");
        quem.textContent = registro.usuario_nome;

        const quando = document.createElement("span");
        quando.className = "quando";
        quando.textContent = formatarData(registro.criado_em);

        item.append(quem, " " + textoDoHistorico(registro), quando);
        lista.appendChild(item);
    }
}

colocarIcone(document.getElementById("btn-fechar-detalhe"), "fechar", "Fechar");
document.getElementById("btn-fechar-detalhe").addEventListener("click", function () {
    dialogDetalhe.close();
});


/* ---------- 6) Criar e editar ticket ---------- */

// Abre o formulário vazio para criar um ticket
document.getElementById("btn-novo-ticket").addEventListener("click", function () {
    ticketEditandoId = null;
    document.getElementById("form-ticket").reset();
    document.getElementById("ticket-titulo-janela").textContent = "Novo ticket";

    // Responsável = quem cria. Usuário comum: fixo nele mesmo. Suporte: pode trocar.
    const ehSuporte = usuarioAtual.perfil === "suporte";
    document.getElementById("campo-responsavel").hidden = false;
    document.getElementById("ticket-responsavel").value = usuarioAtual.id;
    document.getElementById("ticket-responsavel").disabled = !ehSuporte;
    document.getElementById("ticket-dica-responsavel").hidden = ehSuporte;

    dialogTicket.showModal();
});

// Abre o mesmo formulário preenchido com os dados do ticket
function abrirFormularioEditar(ticket) {
    ticketEditandoId = ticket.id;
    document.getElementById("ticket-titulo-janela").textContent = "Editar ticket #" + ticket.id;
    document.getElementById("ticket-titulo").value = ticket.titulo;
    document.getElementById("ticket-descricao").value = ticket.descricao;
    document.getElementById("ticket-prioridade").value = ticket.prioridade;

    // O responsável só existe na criação; ao editar o campo some.
    document.getElementById("campo-responsavel").hidden = true;
    document.getElementById("ticket-dica-responsavel").hidden = true;

    dialogTicket.showModal();
}

document.getElementById("btn-cancelar-ticket").addEventListener("click", function () {
    dialogTicket.close();
});

// Salvar (serve para criar e para editar)
document.getElementById("form-ticket").addEventListener("submit", async function (evento) {
    evento.preventDefault();
    const botao = document.getElementById("btn-salvar-ticket");

    // O backend decide quem pode ser o responsável (usuário comum: sempre ele mesmo).
    const dados = {
        titulo: document.getElementById("ticket-titulo").value,
        descricao: document.getElementById("ticket-descricao").value,
        prioridade: document.getElementById("ticket-prioridade").value,
        responsavel_id: document.getElementById("ticket-responsavel").value,
    };

    botao.disabled = true;
    botao.textContent = "Salvando...";

    let resposta;
    if (ticketEditandoId === null) {
        resposta = await chamarApi("/api/tickets", "POST", dados);
    } else {
        resposta = await chamarApi("/api/tickets/" + ticketEditandoId, "PUT", dados);
    }

    botao.disabled = false;
    botao.textContent = "Salvar";

    if (!resposta.ok) {
        mostrarMensagem(resposta.dados.erro, "erro");
        return;
    }

    dialogTicket.close();
    mostrarMensagem(ticketEditandoId === null ? "Ticket criado no Backlog." : "Ticket atualizado.", "sucesso");
    await atualizarTela();
});


/* ---------- 7) Início do programa ---------- */

// Ao abrir a página: se o cookie de sessão ainda vale, já entra direto;
// senão, mostra o login.
async function iniciar() {
    const resposta = await chamarApi("/api/eu");
    if (resposta.ok) {
        await entrarNoSistema(resposta.dados.usuario);
    } else {
        mostrarTela("login");
    }
}

iniciar();
