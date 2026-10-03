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

// Aviso único do sistema: caixinha no alto da tela, verde (sucesso) ou vermelha (erro),
// que some sozinha ou ao clicar no X. tipo: "sucesso" ou "erro".
// popover = camada acima de tudo, até de janelas abertas.
const avisoCriado = document.getElementById("aviso-criado");
let temporizadorAviso = null;

const ICONE_AVISO = {
    sucesso: '<circle cx="12" cy="12" r="10"/><path d="m8 12.5 3 3 5-6"/>',
    erro: '<circle cx="12" cy="12" r="10"/><path d="M12 7v6"/><path d="M12 16.5v.5"/>',
};

function fecharAvisoCriado() {
    clearTimeout(temporizadorAviso);
    if (avisoCriado.matches(":popover-open")) {
        avisoCriado.hidePopover();
    }
}

function mostrarMensagem(texto, tipo) {
    fecharAvisoCriado();
    tipo = tipo === "erro" ? "erro" : "sucesso";
    avisoCriado.className = tipo;
    document.getElementById("aviso-criado-texto").textContent = texto;
    document.getElementById("aviso-criado-icone").innerHTML = ICONE_AVISO[tipo];
    // A caixinha fica centrada na linha que divide o cabeçalho do resto da página
    const cabecalho = document.querySelector(".cabecalho");
    const linha = cabecalho ? cabecalho.getBoundingClientRect().bottom : 0;
    avisoCriado.style.top = Math.max(linha, 40) + "px";
    avisoCriado.showPopover();
    // erro fica um pouco mais, porque a pessoa precisa ler o que aconteceu
    temporizadorAviso = setTimeout(fecharAvisoCriado, tipo === "erro" ? 5000 : 2500);
}

document.getElementById("btn-fechar-aviso").addEventListener("click", fecharAvisoCriado);

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

// ---------- Arrastar e soltar (drag and drop nativo do navegador) ----------
// O navegador já sabe arrastar elementos; nós só dizemos QUEM pode ser arrastado
// (draggable) e O QUE fazer quando soltar numa coluna (evento "drop").
// Quem decide de verdade se o movimento vale é o backend: aqui só evitamos
// mostrar como possível o que o servidor vai recusar.
let ticketArrastado = null;   // ticket que está sendo arrastado agora (ou null)

// Só dá para soltar nas etapas que o backend liberou para este usuário neste ticket
function podeSoltar(ticket, etapaDestino) {
    return ticket.permissoes.destinos.includes(etapaDestino);
}

// A coluna inteira (título + cards) é a área onde se solta
function colunaDaEtapa(etapa) {
    return document.getElementById("cards-" + etapa).parentElement;
}

function iniciarArrasto(evento, card, ticket) {
    ticketArrastado = ticket;
    evento.dataTransfer.effectAllowed = "move";
    evento.dataTransfer.setData("text/plain", String(ticket.id));  // o Firefox exige algum dado

    // Escurece as colunas onde NÃO dá para soltar, para o usuário ver onde pode
    for (const etapa of Object.keys(NOMES_ETAPAS)) {
        if (etapa !== ticket.etapa && !podeSoltar(ticket, etapa)) {
            colunaDaEtapa(etapa).classList.add("destino-bloqueado");
        }
    }
    // setTimeout: se o card ficasse transparente já agora, a "sombra" arrastada também ficaria
    setTimeout(function () { card.classList.add("arrastando"); }, 0);
}

function terminarArrasto(card) {
    ticketArrastado = null;
    card.classList.remove("arrastando");
    for (const etapa of Object.keys(NOMES_ETAPAS)) {
        colunaDaEtapa(etapa).classList.remove("destino-bloqueado", "destino-ativo");
    }
}

// Liga os eventos de "soltar" em cada coluna (roda uma vez, quando a página carrega)
function configurarColunas() {
    for (const etapa of Object.keys(NOMES_ETAPAS)) {
        const coluna = colunaDaEtapa(etapa);

        // dragover dispara o tempo todo enquanto o card está em cima da coluna.
        // Só quando chamamos preventDefault() o navegador aceita soltar ali.
        coluna.addEventListener("dragover", function (evento) {
            if (ticketArrastado && podeSoltar(ticketArrastado, etapa)) {
                evento.preventDefault();
                coluna.classList.add("destino-ativo");
            }
        });
        coluna.addEventListener("dragleave", function (evento) {
            // dragleave também dispara ao passar por cima de um filho da coluna: ignoramos isso
            if (!coluna.contains(evento.relatedTarget)) {
                coluna.classList.remove("destino-ativo");
            }
        });
        coluna.addEventListener("drop", function (evento) {
            evento.preventDefault();
            coluna.classList.remove("destino-ativo");
            const ticket = ticketArrastado;
            if (ticket && podeSoltar(ticket, etapa)) {
                moverTicket(ticket, etapa);   // a mesma função dos botões: o backend valida
            }
        });
    }
}

// Cria o card de um ticket: #ID, prioridade, título e quem criou.
// É uma <div role="button"> (e não <button>) porque o Firefox não arrasta <button>.
function criarCard(ticket) {
    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("role", "button");
    card.tabIndex = 0;                // dá para chegar nele com a tecla Tab
    card.title = ticket.titulo;       // título completo ao passar o mouse (no card ele pode ser cortado)

    // Todo card pode ser "pego", mas só se move quem tem permissão (suporte) e se o
    // ticket não estiver concluído. Nos outros casos cancelamos o arrasto e explicamos o motivo.
    card.draggable = true;
    if (ticket.permissoes.mover) {
        card.classList.add("movel");   // só estes mostram a mãozinha de "pegar" no CSS
        card.addEventListener("dragstart", function (evento) { iniciarArrasto(evento, card, ticket); });
        card.addEventListener("dragend", function () { terminarArrasto(card); });
    } else {
        card.addEventListener("dragstart", function (evento) {
            evento.preventDefault();   // cancela o arrasto antes de começar
            const motivo = ticket.etapa === "concluido"
                ? "Ticket concluído não pode mais ser movido."
                : "Você só pode mover os seus tickets, e só quando estiverem em Stage.";
            mostrarMensagem(motivo, "erro");
        });
    }

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

    // Rodapé do card: quem criou (esquerda) e quantos comentários tem (direita)
    const rodape = document.createElement("span");
    rodape.className = "card-rodape";
    rodape.appendChild(criador);

    if (ticket.total_comentarios > 0) {
        const comentarios = document.createElement("span");
        comentarios.className = "card-comentarios";
        comentarios.title = ticket.total_comentarios + (ticket.total_comentarios === 1 ? " comentário" : " comentários");
        comentarios.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            ICONES.balao + '</svg>';
        const numero = document.createElement("span");
        numero.textContent = ticket.total_comentarios;
        comentarios.appendChild(numero);
        rodape.appendChild(comentarios);
    }

    card.append(topo, titulo, rodape);

    card.addEventListener("click", function () {
        abrirDetalhe(ticket.id);
    });
    // Como não é um <button>, Enter e Espaço precisam ser ligados à mão
    card.addEventListener("keydown", function (evento) {
        if (evento.key === "Enter" || evento.key === " ") {
            evento.preventDefault();
            abrirDetalhe(ticket.id);
        }
    });
    return card;
}

// --- Abas "Meus tickets" / "Todos os tickets" ---
function escolherAba(soMeus) {
    mostrarSoMeus = soMeus;
    document.getElementById("aba-meus").setAttribute("aria-pressed", String(soMeus));
    document.getElementById("aba-todos").setAttribute("aria-pressed", String(!soMeus));

    // "Criado por" não faz sentido em "Meus tickets" (todos são meus): esconde o filtro
    // e zera o valor, senão ele continuaria filtrando sem aparecer na tela.
    const filtroCriador = document.getElementById("filtro-criador");
    filtroCriador.parentElement.hidden = soMeus;
    if (soMeus) {
        filtroCriador.value = "";
        atualizarEstadoDosFiltros();
    }
    carregarTickets();
}
document.getElementById("aba-meus").addEventListener("click", function () {
    escolherAba(true);
});
document.getElementById("aba-todos").addEventListener("click", function () {
    escolherAba(false);
});

// --- Filtros (aplicam na hora, sem botão "Buscar") ---
const campoBusca = document.getElementById("filtro-busca");
const selectsDeFiltro = [document.getElementById("filtro-prioridade"), document.getElementById("filtro-criador")];

// Destaca o filtro que está ligado e mostra "Limpar filtros" só quando há algum
function atualizarEstadoDosFiltros() {
    let algumLigado = campoBusca.value.trim() !== "";
    for (const select of selectsDeFiltro) {
        const ligado = select.value !== "";
        select.parentElement.classList.toggle("ativo", ligado);
        if (ligado) algumLigado = true;
    }
    document.getElementById("btn-limpar-filtros").hidden = !algumLigado;
}

// Digitar: espera 300 ms depois da última tecla, para não consultar o servidor a cada letra
let temporizadorBusca = null;
campoBusca.addEventListener("input", function () {
    clearTimeout(temporizadorBusca);
    temporizadorBusca = setTimeout(function () {
        atualizarEstadoDosFiltros();
        carregarTickets();
    }, 300);
});

// Trocar um select: aplica na hora
for (const select of selectsDeFiltro) {
    select.addEventListener("change", function () {
        atualizarEstadoDosFiltros();
        carregarTickets();
    });
}

// Enter dentro da busca não deve recarregar a página
document.getElementById("form-filtros").addEventListener("submit", function (evento) {
    evento.preventDefault();
});

document.getElementById("btn-limpar-filtros").addEventListener("click", function () {
    document.getElementById("form-filtros").reset();
    atualizarEstadoDosFiltros();
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
    desenharComentarios(resposta.dados.comentarios, ticket.permissoes.comentar);

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
    // três bolinhas cheias na vertical (fill + stroke="none": o traço do ícone não vira contorno)
    pontos: '<circle cx="12" cy="5" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.8" fill="currentColor" stroke="none"/>',
    balao: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
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
        // Só mostra os botões para destinos que o backend liberou a este usuário
        const anterior = ticket.permissoes.destinos.includes(VOLTAR[ticket.etapa]) ? VOLTAR[ticket.etapa] : null;
        const proxima = ticket.permissoes.destinos.includes(AVANCAR[ticket.etapa]) ? AVANCAR[ticket.etapa] : null;

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
let movendoTicket = false;   // true enquanto uma movimentação está em andamento

async function moverTicket(ticket, novaEtapa) {
    // Se o servidor ainda está respondendo ao movimento anterior, ignora o novo.
    // (Sem isso, soltar o card duas vezes seguidas manda um movimento já inválido.)
    if (movendoTicket) return;
    movendoTicket = true;
    try {
        await executarMovimento(ticket, novaEtapa);
    } finally {
        movendoTicket = false;
    }
}

async function executarMovimento(ticket, novaEtapa) {
    if (novaEtapa === "concluido") {
        const confirmou = await confirmar(
            "Concluir ticket?",
            "Após a conclusão, o ticket não poderá mais ser movido nem editado.",
            "Concluir");
        if (!confirmou) return;
    }

    const corpo = { etapa: novaEtapa };
    if (ticket.etapa === "stage" && novaEtapa === "andamento") {
        const motivo = await pedirMotivoDaDevolucao();
        if (motivo === null) return;
        corpo.motivo = motivo;
    }

    const resposta = await chamarApi("/api/tickets/" + ticket.id + "/etapa", "PUT", corpo);
    if (!resposta.ok) {
        mostrarMensagem(resposta.dados.erro, "erro");
        await atualizarTela();   // a tela estava desatualizada: recarrega para mostrar a situação real
        return;
    }
    // Qualquer movimentação feita pela janela de detalhes fecha a janela e volta ao Kanban,
    // onde já dá para ver o card na nova coluna.
    if (dialogDetalhe.open) {
        dialogDetalhe.close();
    }
    // Só concluir ganha aviso: as outras movimentações já se veem no próprio Kanban.
    if (novaEtapa === "concluido") {
        mostrarMensagem("Ticket concluído com sucesso!", "sucesso");
    }
    await atualizarTela();
}

// Abre a janela do motivo. Devolve o texto digitado, ou null se a pessoa cancelou.
function pedirMotivoDaDevolucao() {
    const dialogo = document.getElementById("dialog-devolver");
    const campo = document.getElementById("devolver-motivo");
    campo.value = "";
    dialogo.returnValue = "";
    dialogo.showModal();
    campo.focus();
    return new Promise(function (resolver) {
        dialogo.addEventListener("close", function () {
            resolver(dialogo.returnValue === "ok" ? campo.value.trim() : null);
        }, { once: true });
    });
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
            if (de === "stage" && para === "andamento") {
                return "devolveu o ticket de Stage para Em andamento";
            }
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


// Guardamos a última lista desenhada para poder redesenhar (ex.: ao cancelar uma edição)
let comentariosAtuais = [];
let podeComentarAtual = false;

// Enter envia o formulário do campo; Shift+Enter quebra a linha (como em chats e redes sociais).
// isComposing: não envia enquanto a pessoa está montando um acento/caractere no teclado.
function enviarComEnter(campo, botaoEnviar) {
    campo.addEventListener("keydown", function (evento) {
        if (evento.key === "Enter" && !evento.shiftKey && !evento.isComposing) {
            evento.preventDefault();       // sem isso o Enter inseriria uma quebra de linha
            // dispara o submit normal (inclusive a validação do "required").
            // botaoEnviar: em <form method="dialog"> é o botão enviado que define o returnValue.
            campo.form.requestSubmit(botaoEnviar);
        }
    });
}
enviarComEnter(document.getElementById("comentario-texto"));
enviarComEnter(document.getElementById("devolver-motivo"),
               document.querySelector("#dialog-devolver button[value=ok]"));

// Lista os comentários (do mais antigo ao mais novo) e mostra o formulário só se puder comentar
function desenharComentarios(comentarios, podeComentar) {
    comentariosAtuais = comentarios;
    podeComentarAtual = podeComentar;

    const lista = document.getElementById("lista-comentarios");
    lista.replaceChildren();
    document.getElementById("contador-comentarios").textContent = comentarios.length;

    for (const comentario of comentarios) {
        const item = document.createElement("li");

        const cabecalho = document.createElement("div");
        cabecalho.className = "comentario-cabecalho";

        const info = document.createElement("span");
        const autor = document.createElement("strong");
        autor.textContent = comentario.usuario_nome;      // textContent: nunca interpreta HTML
        info.append(autor, " · " + formatarData(comentario.criado_em));
        if (comentario.editado_em) {
            const editado = document.createElement("span");
            editado.textContent = " · editado";
            editado.title = "Editado em " + formatarData(comentario.editado_em);
            info.appendChild(editado);
        }
        cabecalho.appendChild(info);

        const texto = document.createElement("p");
        texto.textContent = comentario.texto;

        // O menu de três pontinhos só existe para quem pode editar ou excluir este comentário
        if (comentario.permissoes.editar || comentario.permissoes.excluir) {
            cabecalho.appendChild(criarMenuDoComentario(comentario, item, texto));
        }

        item.append(cabecalho, texto);
        lista.appendChild(item);
    }

    document.getElementById("form-comentario").hidden = !podeComentar;
    document.getElementById("comentario-aviso").hidden = podeComentar;
}

// Fecha os menus abertos (menos o indicado). Chamado ao abrir outro menu ou clicar fora.
function fecharMenusDeComentario(exceto) {
    for (const menu of document.querySelectorAll(".comentario-menu")) {
        if (menu !== exceto && !menu.hidden) {
            menu.hidden = true;
            menu.previousElementSibling.setAttribute("aria-expanded", "false");
        }
    }
}
document.addEventListener("click", function (evento) {
    if (!evento.target.closest(".comentario-opcoes")) {
        fecharMenusDeComentario(null);
    }
});

// Botão "…" com o menu Editar / Excluir
function criarMenuDoComentario(comentario, item, paragrafoTexto) {
    const area = document.createElement("div");
    area.className = "comentario-opcoes";

    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "secundario discreto";
    botao.setAttribute("aria-haspopup", "menu");
    botao.setAttribute("aria-expanded", "false");
    colocarIcone(botao, "pontos", "Opções do comentário");

    const menu = document.createElement("div");
    menu.className = "comentario-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    if (comentario.permissoes.editar) {
        const editar = document.createElement("button");
        editar.type = "button";
        editar.setAttribute("role", "menuitem");
        editar.textContent = "Editar";
        editar.addEventListener("click", function () {
            fecharMenusDeComentario(null);
            iniciarEdicaoDeComentario(comentario, item, paragrafoTexto);
        });
        menu.appendChild(editar);
    }
    if (comentario.permissoes.excluir) {
        const excluir = document.createElement("button");
        excluir.type = "button";
        excluir.className = "perigo-texto";
        excluir.setAttribute("role", "menuitem");
        excluir.textContent = "Excluir";
        excluir.addEventListener("click", function () {
            fecharMenusDeComentario(null);
            excluirComentario(comentario);
        });
        menu.appendChild(excluir);
    }

    botao.addEventListener("click", function () {
        const abrir = menu.hidden;
        fecharMenusDeComentario(menu);   // fecha qualquer outro que esteja aberto
        menu.hidden = !abrir;
        botao.setAttribute("aria-expanded", String(abrir));
    });

    area.append(botao, menu);
    return area;
}

// Troca o texto do comentário por uma caixa de edição (no próprio lugar)
function iniciarEdicaoDeComentario(comentario, item, paragrafoTexto) {
    const form = document.createElement("form");
    form.className = "form-comentario";

    const campo = document.createElement("textarea");
    campo.rows = 3;
    campo.maxLength = 1000;
    campo.required = true;
    campo.value = comentario.texto;
    campo.setAttribute("aria-label", "Editar comentário");

    const botoes = document.createElement("div");
    botoes.className = "botoes";
    botoes.style.marginTop = "0";
    const cancelar = document.createElement("button");
    cancelar.type = "button";
    cancelar.className = "secundario";
    cancelar.textContent = "Cancelar";
    cancelar.addEventListener("click", function () {
        desenharComentarios(comentariosAtuais, podeComentarAtual);   // volta ao texto original
    });
    const salvar = document.createElement("button");
    salvar.type = "submit";
    salvar.textContent = "Salvar";
    botoes.append(cancelar, salvar);

    form.append(campo, botoes);
    form.addEventListener("submit", async function (evento) {
        evento.preventDefault();
        salvar.disabled = true;
        const resposta = await chamarApi("/api/comentarios/" + comentario.id, "PUT", { texto: campo.value });
        if (!resposta.ok) {
            salvar.disabled = false;
            mostrarMensagem(resposta.dados.erro, "erro");
            return;
        }
        await atualizarTela();
    });

    paragrafoTexto.replaceWith(form);
    enviarComEnter(campo);   // na edição também: Enter salva, Shift+Enter quebra a linha
    campo.focus();
}

async function excluirComentario(comentario) {
    const confirmou = await confirmar(
        "Excluir comentário?",
        "O comentário deixará de aparecer neste ticket.",
        "Excluir",
        true);
    if (!confirmou) return;

    const resposta = await chamarApi("/api/comentarios/" + comentario.id, "DELETE");
    if (!resposta.ok) {
        mostrarMensagem(resposta.dados.erro, "erro");
        return;
    }
    await atualizarTela();
}

document.getElementById("form-comentario").addEventListener("submit", async function (evento) {
    evento.preventDefault();
    const campo = document.getElementById("comentario-texto");
    const botao = document.getElementById("btn-comentar");

    botao.disabled = true;
    const resposta = await chamarApi(
        "/api/tickets/" + ticketAbertoId + "/comentarios", "POST", { texto: campo.value });
    botao.disabled = false;

    if (!resposta.ok) {
        mostrarMensagem(resposta.dados.erro, "erro");
        return;
    }
    campo.value = "";
    await atualizarTela();   // o comentário novo aparece na lista e o contador do card sobe
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
    if (ticketEditandoId === null) {
        mostrarMensagem("Ticket criado com sucesso!", "sucesso");
    } else {
        mostrarMensagem("Ticket atualizado.", "sucesso");
    }
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

configurarColunas();
iniciar();
