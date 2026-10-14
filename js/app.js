// Página pública: grade de números, reserva, pagamento Pix e envio do comprovante.

import {
  auth, db, firebaseConfigurado, obterStorage,
  onAuthStateChanged, signInAnonymously,
  doc, collection, onSnapshot, query, where, runTransaction, serverTimestamp,
  ref as refStorage, uploadBytes
} from "./firebase.js";
import {
  STATUS_NUMERO, STATUS_RESERVA, statusPublico, expiraEm, faixaNumeros, formatarNumero,
  formatarMoeda, formatarHora, mascararTelefone, escapeHtml, toast, copiarTexto,
  mensagemErro, legendaHtml, linkWhatsApp
} from "./common.js";
import { gerarPixCopiaECola } from "./pix.js";

const $ = (id) => document.getElementById(id);

const estado = {
  config: null,
  configCarregada: false,
  numeros: new Map(),   // id do número -> dados públicos
  numerosCarregados: false,
  minhas: [],           // reservas do participante (usuário anônimo)
  uid: null,
  pendente: null,       // { numero, ref } — mesma referência em novas tentativas (evita duplicar)
  pagamento: null       // reserva aberta no diálogo de pagamento
};

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------

$("legenda").innerHTML = legendaHtml();

if (!firebaseConfigurado) {
  mostrarAviso("O sistema ainda não foi conectado ao Firebase. Edite o arquivo js/firebase-config.js (veja o README).");
  $("titulo").textContent = "Rifa Online";
  $("grade").innerHTML = "";
} else {
  iniciar();
}

function iniciar() {
  onSnapshot(doc(db, "config", "rifa"), (snap) => {
    estado.config = snap.exists() ? snap.data() : null;
    estado.configCarregada = true;
    renderCabecalho();
    renderGrade();
    renderMinhas();
  }, erroConexao);

  onSnapshot(collection(db, "numeros"), (snap) => {
    estado.numeros = new Map(snap.docs.map((d) => [d.id, d.data({ serverTimestamps: "estimate" })]));
    estado.numerosCarregados = true;
    renderGrade();
    renderMinhas();
    atualizarPrazo();
  }, erroConexao);

  let pararMinhas = null;
  onAuthStateChanged(auth, (user) => {
    if (pararMinhas) { pararMinhas(); pararMinhas = null; }
    if (!user) {
      estado.uid = null;
      signInAnonymously(auth).catch((e) => {
        console.error(e);
        mostrarAviso("Não foi possível conectar. Verifique sua internet e recarregue a página.");
      });
      return;
    }
    estado.uid = user.uid;
    pararMinhas = onSnapshot(query(collection(db, "reservas"), where("uid", "==", user.uid)), (snap) => {
      estado.minhas = snap.docs
        .map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))
        .sort((a, b) => (b.criadaEm?.toMillis?.() ?? 0) - (a.criadaEm?.toMillis?.() ?? 0));
      renderMinhas();
      renderGrade();
      if (estado.pagamento) {
        const atual = estado.minhas.find((r) => r.id === estado.pagamento.id);
        if (atual) { estado.pagamento = atual; atualizarPrazo(); }
      }
    }, (e) => console.error(e));
  });

  // Atualiza contagens regressivas e expirações sem depender de novos dados.
  setInterval(() => { renderGrade(); renderMinhas(); atualizarPrazo(); }, 15000);
}

function erroConexao(e) {
  console.error(e);
  mostrarAviso("Falha ao carregar os dados. Verifique sua conexão; a página tentará novamente.");
}

function mostrarAviso(texto) {
  const el = $("aviso");
  el.textContent = texto;
  el.hidden = false;
}

// ---------------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------------

function renderCabecalho() {
  const c = estado.config;
  if (!c) {
    $("titulo").textContent = "Rifa Online";
    $("descricao").textContent = "A rifa ainda não foi configurada pela organização.";
    $("valor").textContent = "—";
    return;
  }
  $("titulo").textContent = c.titulo || "Rifa Online";
  $("descricao").textContent = c.descricao || "";
  $("valor").textContent = formatarMoeda(c.valor);
  const contato = $("contato");
  contato.hidden = !c.contato;
  if (c.contato) {
    const wa = linkWhatsApp(c.contato);
    contato.innerHTML = `Dúvidas? Fale com a organização: ${wa
      ? `<a href="${wa}" target="_blank" rel="noopener">${escapeHtml(c.contato)}</a>`
      : escapeHtml(c.contato)}`;
  }
  document.title = c.titulo ? `${c.titulo} · Rifa Online` : "Rifa Online";
}

function minhaReservaDoNumero(n) {
  const num = estado.numeros.get(String(n));
  if (!num) return null;
  return estado.minhas.find((r) => r.id === num.reservaId) || null;
}

function renderGrade() {
  const grade = $("grade");
  if (!estado.configCarregada || !estado.numerosCarregados) return;
  grade.setAttribute("aria-busy", "false");

  if (!estado.config) {
    grade.innerHTML = `<p class="carregando">Os números serão exibidos assim que a rifa for configurada.</p>`;
    $("resumoGrade").textContent = "";
    return;
  }

  const agora = Date.now();
  let livres = 0;
  const lista = faixaNumeros(estado.config);
  grade.innerHTML = lista.map((n) => {
    const st = statusPublico(estado.numeros.get(String(n)), estado.config, agora);
    const info = STATUS_NUMERO[st];
    const livre = st === "disponivel";
    if (livre) livres++;
    const meu = !livre && minhaReservaDoNumero(n);
    const rotulo = `Número ${n}: ${info.rotulo}${meu ? " (sua reserva)" : ""}`;
    return `<button type="button" class="num st-${st}${meu ? " meu" : ""}" data-n="${n}"
              ${livre || meu ? "" : "aria-disabled=\"true\""} aria-label="${escapeHtml(rotulo)}" title="${escapeHtml(rotulo)}">
              <span class="num-valor">${formatarNumero(n)}</span>
              <span class="num-status">${info.icone ? info.icone + " " : ""}${meu ? "seu" : info.curto}</span>
            </button>`;
  }).join("");
  $("resumoGrade").textContent = `${livres} de ${lista.length} disponíveis`;
}

function renderMinhas() {
  const sec = $("minhas");
  const visiveis = estado.minhas.filter((r) => r.status !== "cancelada" && r.status !== "expirada");
  if (!visiveis.length) { sec.hidden = true; return; }
  sec.hidden = false;
  $("listaMinhas").innerHTML = visiveis.map((r) => {
    const sit = situacaoReserva(r);
    const acao = sit.podePagar
      ? `<button type="button" class="botao botao-primario" data-pagar="${r.id}">${r.status === "invalido" ? "Reenviar comprovante" : "Pagar / informar comprovante"}</button>`
      : "";
    return `<li class="item-minha">
      <span class="num-mini st-${sit.classe}">${formatarNumero(r.numero)}</span>
      <div class="item-minha-info">
        <strong>${escapeHtml(sit.titulo)}</strong>
        <span class="ajuda">${escapeHtml(sit.detalhe)}</span>
      </div>
      ${acao}
    </li>`;
  }).join("");
}

/** Situação de uma reserva do participante, do ponto de vista dele. */
function situacaoReserva(r) {
  const num = estado.numeros.get(String(r.numero));
  const vinculada = num && num.reservaId === r.id;
  if (r.status === "pago") return { classe: "pago", titulo: "Pagamento confirmado", detalhe: "Seu número está garantido. Boa sorte!" };
  if (r.status === "analise") return { classe: "analise", titulo: STATUS_RESERVA.analise, detalhe: "A equipe está conferindo o seu pagamento." };
  if (!vinculada) return { classe: "disponivel", titulo: "Reserva encerrada", detalhe: "O prazo terminou e o número foi liberado." };
  const fim = expiraEm(num, estado.config);
  const vencida = fim != null && Date.now() > fim;
  if (r.status === "invalido") {
    return { classe: "aguardando", titulo: STATUS_RESERVA.invalido, detalhe: vencida ? "Prazo encerrado — reenvie o comprovante o quanto antes." : `Reenvie o comprovante até ${formatarHora(fim)}.`, podePagar: true };
  }
  return {
    classe: "aguardando",
    titulo: STATUS_RESERVA.aguardando,
    detalhe: vencida ? "Prazo encerrado — se já pagou, informe o comprovante agora." : `Reserva garantida até ${formatarHora(fim)}.`,
    podePagar: true
  };
}

// ---------------------------------------------------------------------------
// Diálogos
// ---------------------------------------------------------------------------

document.querySelectorAll("dialog").forEach((dlg) => {
  dlg.addEventListener("click", (e) => {
    if (e.target.closest("[data-fechar]")) dlg.close();
  });
});
$("dlgPagamento").addEventListener("close", () => { estado.pagamento = null; });

$("grade").addEventListener("click", (e) => {
  const btn = e.target.closest("button.num");
  if (!btn) return;
  const n = Number(btn.dataset.n);
  const meu = minhaReservaDoNumero(n);
  if (meu) {
    if (situacaoReserva(meu).podePagar) abrirPagamento(meu);
    else toast(`Número ${formatarNumero(n)}: ${situacaoReserva(meu).titulo}.`);
    return;
  }
  const st = statusPublico(estado.numeros.get(String(n)), estado.config);
  if (st !== "disponivel") {
    toast(`O número ${formatarNumero(n)} não está disponível (${STATUS_NUMERO[st].rotulo.toLowerCase()}).`);
    return;
  }
  abrirReserva(n);
});

$("listaMinhas").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-pagar]");
  if (!btn) return;
  const r = estado.minhas.find((x) => x.id === btn.dataset.pagar);
  if (r) abrirPagamento(r);
});

// ---------------------------------------------------------------------------
// Reserva
// ---------------------------------------------------------------------------

function abrirReserva(n) {
  if (!estado.uid) { toast("Conectando… tente novamente em instantes."); return; }
  if (estado.pendente?.numero !== n) {
    estado.pendente = { numero: n, ref: doc(collection(db, "reservas")) };
  }
  $("reservaNumeroTitulo").textContent = formatarNumero(n);
  $("reservaNumero").value = formatarNumero(n);
  $("reservaErro").hidden = true;
  $("btnReservar").disabled = false;
  $("btnReservar").textContent = "Reservar e pagar";
  $("dlgReserva").showModal();
  $("reservaNome").focus();
}

$("reservaTelefone").addEventListener("input", (e) => {
  e.target.value = mascararTelefone(e.target.value);
});

$("formReserva").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nome = $("reservaNome").value.trim().replace(/\s+/g, " ");
  const telefone = $("reservaTelefone").value.trim();
  const digitos = telefone.replace(/\D/g, "");
  const erro = $("reservaErro");

  if (nome.length < 3 || !nome.includes(" ")) return mostrarErro(erro, "Informe seu nome completo (nome e sobrenome).");
  if (digitos.length < 10 || digitos.length > 11) return mostrarErro(erro, "Informe um telefone válido com DDD.");
  if (!estado.pendente) return;

  const { numero, ref: resRef } = estado.pendente;
  const numRef = doc(db, "numeros", String(numero));
  const config = estado.config;
  const btn = $("btnReservar");
  btn.disabled = true;
  btn.textContent = "Reservando…";
  erro.hidden = true;

  try {
    await runTransaction(db, async (tx) => {
      // 1. Verifica novamente, no servidor, se o número continua disponível.
      const snap = await tx.get(numRef);
      if (snap.exists()) {
        const d = snap.data();
        if (d.reservaId === resRef.id) return; // tentativa anterior já foi gravada
        if (statusPublico(d, config) !== "disponivel") throw codigo("INDISPONIVEL");
      }
      // 2-5. Grava a reserva e o vínculo do número juntos (atômico).
      tx.set(resRef, {
        numero, nome, telefone,
        uid: estado.uid,
        valor: config.valor,
        status: "aguardando",
        criadaEm: serverTimestamp()
      });
      tx.set(numRef, { status: "aguardando", reservaId: resRef.id, reservadoEm: serverTimestamp() });
    });

    estado.pendente = null;
    $("dlgReserva").close();
    $("formReserva").reset();
    toast(`Número ${formatarNumero(numero)} reservado!`, "sucesso");
    // 6. Segue para o pagamento.
    abrirPagamento({ id: resRef.id, numero, nome, telefone, valor: config.valor, status: "aguardando" });
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = "Reservar e pagar";
    if (err.codigo === "INDISPONIVEL" || err.code === "permission-denied") {
      estado.pendente = null;
      mostrarErro(erro, "Não foi possível reservar: este número acabou de ser reservado por outra pessoa. Feche e escolha outro.");
      btn.disabled = true;
    } else {
      // Falha de conexão: a mesma referência será reutilizada, sem risco de duplicar.
      mostrarErro(erro, mensagemErro(err));
    }
  }
});

function codigo(c) {
  const e = new Error(c);
  e.codigo = c;
  return e;
}

function mostrarErro(el, texto) {
  el.textContent = texto;
  el.hidden = false;
}

// ---------------------------------------------------------------------------
// Pagamento
// ---------------------------------------------------------------------------

function abrirPagamento(reserva) {
  estado.pagamento = reserva;
  const c = estado.config || {};

  $("pagNumero").textContent = formatarNumero(reserva.numero);
  $("pagNome").textContent = reserva.nome;
  $("pagValor").textContent = formatarMoeda(reserva.valor);
  $("pagInvalido").hidden = reserva.status !== "invalido";
  $("pagConteudo").hidden = false;
  $("pagEnviado").hidden = true;
  $("compErro").hidden = true;
  $("formComprovante").reset();
  $("btnEnviarComp").disabled = false;
  $("btnEnviarComp").textContent = "Já realizei o pagamento";
  $("compArquivoCampo").hidden = !c.permitirArquivo;

  // Dados Pix
  const codigoPix = c.pixCopiaECola
    || (c.pixChave && c.pixNome && c.pixCidade
      ? gerarPixCopiaECola({ chave: c.pixChave, nome: c.pixNome, cidade: c.pixCidade, valor: reserva.valor, txid: `RIFA${reserva.numero}` })
      : "");
  $("pixChaveBloco").hidden = !c.pixChave;
  $("pixChave").textContent = c.pixChave || "";
  $("pixCodigoBloco").hidden = !codigoPix;
  $("pixCodigo").value = codigoPix;
  $("pixSemDados").hidden = Boolean(c.pixChave || codigoPix);
  renderQr(c.qrCodeUrl, codigoPix);

  atualizarPrazo();
  if (!$("dlgPagamento").open) $("dlgPagamento").showModal();
}

function renderQr(url, codigoPix) {
  const box = $("pixQr");
  box.innerHTML = "";
  if (url) {
    const img = new Image();
    img.alt = "QR Code Pix";
    img.src = url;
    box.appendChild(img);
    box.hidden = false;
  } else if (codigoPix && window.qrcode) {
    const qr = window.qrcode(0, "M");
    qr.addData(codigoPix);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    box.querySelector("svg")?.setAttribute("aria-label", "QR Code Pix");
    box.hidden = false;
  } else {
    box.hidden = true;
  }
}

function atualizarPrazo() {
  const r = estado.pagamento;
  if (!r) return;
  const el = $("pagPrazo");
  const num = estado.numeros.get(String(r.numero));
  const form = $("formComprovante");

  if (r.status === "analise" || r.status === "pago") {
    el.textContent = r.status === "pago" ? "Pagamento confirmado." : "Comprovante enviado — pagamento em análise.";
    el.className = "prazo";
    form.hidden = true;
    return;
  }
  if (num && num.reservaId !== r.id) {
    el.textContent = "O prazo terminou e este número foi reservado por outra pessoa. Fale com a organização se você já pagou.";
    el.className = "prazo prazo-vencido";
    form.hidden = true;
    return;
  }
  form.hidden = false;
  const fim = num ? expiraEm(num, estado.config) : Date.now() + (estado.config?.reservaMinutos || 0) * 60000;
  const restante = Math.ceil((fim - Date.now()) / 60000);
  if (restante > 0) {
    el.textContent = `Reserva garantida até ${formatarHora(fim)} (faltam cerca de ${restante} min).`;
    el.className = "prazo";
  } else {
    el.textContent = "O prazo da reserva terminou. Se você já pagou, informe o comprovante agora — o número pode ser liberado a qualquer momento.";
    el.className = "prazo prazo-vencido";
  }
}

$("btnCopiarChave").addEventListener("click", () => copiarTexto($("pixChave").textContent));
$("btnCopiarCodigo").addEventListener("click", () => copiarTexto($("pixCodigo").value));

$("formComprovante").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = estado.pagamento;
  if (!r) return;
  const erro = $("compErro");
  const comprovanteId = $("compId").value.trim();
  const referencia = $("compRef").value.trim();
  const arquivo = $("compArquivo").files?.[0] || null;

  if (comprovanteId.length < 3) return mostrarErro(erro, "Informe o identificador do comprovante.");
  if (arquivo) {
    if (arquivo.size > 5 * 1024 * 1024) return mostrarErro(erro, "O arquivo deve ter no máximo 5 MB.");
    if (!/^image\/|^application\/pdf$/.test(arquivo.type)) return mostrarErro(erro, "Envie uma imagem ou um PDF.");
  }

  const btn = $("btnEnviarComp");
  btn.disabled = true;
  btn.textContent = "Enviando…";
  erro.hidden = true;

  const resRef = doc(db, "reservas", r.id);
  const numRef = doc(db, "numeros", String(r.numero));

  try {
    let caminho = "";
    if (arquivo && estado.config?.permitirArquivo) {
      const nomeSeguro = arquivo.name.replace(/[^\w.-]+/g, "_").slice(-80);
      caminho = `comprovantes/${estado.uid}/${r.id}/${Date.now()}-${nomeSeguro}`;
      await uploadBytes(refStorage(obterStorage(), caminho), arquivo, { contentType: arquivo.type });
    }

    await runTransaction(db, async (tx) => {
      const rs = await tx.get(resRef);
      const ns = await tx.get(numRef);
      if (!rs.exists()) throw codigo("NAO_ENCONTRADA");
      const atual = rs.data();
      if (!["aguardando", "invalido"].includes(atual.status)) throw codigo("JA_ENVIADO");
      if (!ns.exists() || ns.data().reservaId !== r.id) throw codigo("PERDIDA");
      tx.update(resRef, {
        status: "analise",
        comprovanteId,
        referencia,
        arquivo: caminho,
        comprovanteEnviadoEm: serverTimestamp()
      });
      tx.update(numRef, { status: "analise" });
    });

    estado.pagamento = { ...r, status: "analise" };
    $("pagConteudo").hidden = true;
    $("pagEnviado").hidden = false;
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = "Já realizei o pagamento";
    const msg = {
      NAO_ENCONTRADA: "Reserva não encontrada.",
      JA_ENVIADO: "O comprovante desta reserva já foi enviado.",
      PERDIDA: "O prazo terminou e o número foi reservado por outra pessoa. Fale com a organização."
    }[err.codigo] || mensagemErro(err);
    mostrarErro(erro, msg);
  }
});
