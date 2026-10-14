// Painel gerencial: autenticação, indicadores, consulta e operações sobre reservas.
// As permissões reais são garantidas pelas regras do Firestore (firestore.rules);
// as verificações aqui servem apenas para orientar o operador.

import {
  auth, db, firebaseConfigurado, obterStorage,
  onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail,
  doc, collection, getDoc, getDocs, onSnapshot, query, where, orderBy,
  runTransaction, serverTimestamp, setDoc,
  ref as refStorage, getDownloadURL
} from "./firebase.js";
import {
  STATUS_RESERVA, statusPublico, expiraEm, faixaNumeros, formatarNumero, formatarMoeda,
  formatarDataHora, escapeHtml, toast, mensagemErro, linkWhatsApp, emMs
} from "./common.js";

const $ = (id) => document.getElementById(id);

const estado = {
  usuario: null,
  config: null,
  numeros: new Map(),
  reservas: [],
  pararListeners: [],
  acaoPendente: null,   // { reserva, acao }
  detalheId: null
};

/** Status do documento público do número para cada status de reserva. */
const STATUS_NUMERO_PARA = { aguardando: "aguardando", invalido: "aguardando", analise: "analise", pago: "pago" };
const FINAIS = ["cancelada", "expirada"];

/**
 * Ações operacionais. `pode` recebe a reserva e o contexto atual do número:
 *   ativo   -> o número ainda está vinculado a esta reserva
 *   vencida -> reserva aguardando pagamento com prazo expirado
 */
const ACOES = {
  confirmar: {
    rotulo: "Confirmar pagamento", novo: "pago", classe: "botao-primario",
    pode: (r, c) => c.ativo && ["aguardando", "analise", "invalido"].includes(r.status),
    texto: (r) => `Confirmar o pagamento do número ${formatarNumero(r.numero)} de ${r.nome}, no valor de ${formatarMoeda(r.valor)}? Confira o comprovante antes de confirmar.`
  },
  analise: {
    rotulo: "Manter em análise", novo: "analise", classe: "botao-secundario",
    pode: (r, c) => c.ativo && ["aguardando", "analise", "invalido", "pago"].includes(r.status),
    texto: (r) => `Manter o pagamento do número ${formatarNumero(r.numero)} (${r.nome}) como “em análise”?`
  },
  invalido: {
    rotulo: "Não identificado", novo: "invalido", classe: "botao-perigo",
    pode: (r, c) => c.ativo && ["aguardando", "analise", "pago"].includes(r.status),
    texto: (r) => `Marcar o pagamento do número ${formatarNumero(r.numero)} (${r.nome}) como não identificado/inválido? O participante poderá reenviar o comprovante dentro de um novo prazo.`
  },
  cancelar: {
    rotulo: "Cancelar reserva", novo: "cancelada", classe: "botao-perigo",
    pode: (r) => ["aguardando", "analise", "invalido", "pago"].includes(r.status),
    texto: (r) => `Cancelar a reserva do número ${formatarNumero(r.numero)} de ${r.nome}?${r.status === "pago" ? " ATENÇÃO: esta reserva já está PAGA." : ""} O número voltará a ficar disponível.`
  },
  liberar: {
    rotulo: "Liberar número", novo: "expirada", classe: "botao-secundario",
    pode: (r, c) => ["aguardando", "invalido"].includes(r.status) && (!c.ativo || c.vencida || r.status === "invalido"),
    texto: (r) => `Liberar o número ${formatarNumero(r.numero)}? A reserva de ${r.nome} será encerrada como expirada e o número ficará disponível para outras pessoas.`
  }
};

// ---------------------------------------------------------------------------
// Autenticação
// ---------------------------------------------------------------------------

function mostrarTela(tela) {
  $("telaLogin").hidden = tela !== "login";
  $("telaSemPermissao").hidden = tela !== "semPermissao";
  $("painel").hidden = tela !== "painel";
  $("usuarioTopo").hidden = tela !== "painel";
}

if (!firebaseConfigurado) {
  $("aviso").textContent = "O sistema ainda não foi conectado ao Firebase. Edite js/firebase-config.js (veja o README).";
  $("aviso").hidden = false;
} else {
  onAuthStateChanged(auth, async (user) => {
    pararPainel();
    if (!user || user.isAnonymous) {
      mostrarTela("login");
      return;
    }
    try {
      const adm = await getDoc(doc(db, "admins", user.uid));
      if (!adm.exists()) {
        $("semPermissaoUid").textContent = user.uid;
        mostrarTela("semPermissao");
        return;
      }
    } catch (e) {
      console.error(e);
      $("semPermissaoUid").textContent = user.uid;
      mostrarTela("semPermissao");
      return;
    }
    estado.usuario = user;
    $("usuarioEmail").textContent = user.email;
    mostrarTela("painel");
    iniciarPainel();
  });
}

$("formLogin").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("loginEmail").value.trim();
  const senha = $("loginSenha").value;
  const erro = $("loginErro");
  if (!email || !senha) { erro.textContent = "Informe e-mail e senha."; erro.hidden = false; return; }
  const btn = $("btnEntrar");
  btn.disabled = true;
  btn.textContent = "Entrando…";
  erro.hidden = true;
  try {
    await signInWithEmailAndPassword(auth, email, senha);
    $("loginSenha").value = "";
  } catch (err) {
    console.error(err);
    erro.textContent = {
      "auth/invalid-credential": "E-mail ou senha incorretos.",
      "auth/wrong-password": "E-mail ou senha incorretos.",
      "auth/user-not-found": "E-mail ou senha incorretos.",
      "auth/invalid-email": "E-mail inválido.",
      "auth/too-many-requests": "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
      "auth/network-request-failed": "Falha de conexão. Verifique sua internet."
    }[err.code] || "Não foi possível entrar. Tente novamente.";
    erro.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
});

$("btnEsqueci").addEventListener("click", async () => {
  const email = $("loginEmail").value.trim();
  if (!email) { toast("Digite seu e-mail no campo acima e clique novamente."); $("loginEmail").focus(); return; }
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (e) {
    console.error(e);
  }
  toast("Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.");
});

$("btnSair").addEventListener("click", () => signOut(auth));
$("btnSairSemPermissao").addEventListener("click", () => signOut(auth));

// ---------------------------------------------------------------------------
// Dados em tempo real
// ---------------------------------------------------------------------------

function iniciarPainel() {
  const falha = (e) => {
    console.error(e);
    $("aviso").textContent = "Falha ao sincronizar os dados. Verifique a conexão; os dados serão atualizados automaticamente.";
    $("aviso").hidden = false;
  };
  const ok = () => { $("aviso").hidden = true; };

  estado.pararListeners.push(onSnapshot(doc(db, "config", "rifa"), (snap) => {
    ok();
    estado.config = snap.exists() ? snap.data() : null;
    preencherConfig();
    renderTudo();
  }, falha));

  estado.pararListeners.push(onSnapshot(collection(db, "numeros"), (snap) => {
    ok();
    estado.numeros = new Map(snap.docs.map((d) => [d.id, d.data({ serverTimestamps: "estimate" })]));
    renderTudo();
  }, falha));

  estado.pararListeners.push(onSnapshot(query(collection(db, "reservas"), orderBy("criadaEm", "desc")), (snap) => {
    ok();
    estado.reservas = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    renderTudo();
  }, falha));

  const relogio = setInterval(renderTudo, 30000);
  estado.pararListeners.push(() => clearInterval(relogio));
}

function pararPainel() {
  estado.pararListeners.forEach((parar) => parar());
  estado.pararListeners = [];
  estado.usuario = null;
  estado.reservas = [];
  estado.numeros = new Map();
  configCarregada = false;
}

function contexto(r, numeroDoc = estado.numeros.get(String(r.numero))) {
  const ativo = Boolean(numeroDoc && numeroDoc.reservaId === r.id);
  const fim = ativo ? expiraEm(numeroDoc, estado.config) : null;
  const vencida = ativo && numeroDoc.status === "aguardando" && fim != null && Date.now() > fim;
  return { ativo, vencida, fim };
}

function renderTudo() {
  if (!estado.usuario) return;
  renderIndicadores();
  renderTabela();
  if (estado.detalheId && $("dlgDetalhes").open) renderDetalhes(estado.detalheId, false);
}

// ---------------------------------------------------------------------------
// Indicadores
// ---------------------------------------------------------------------------

function renderIndicadores() {
  const c = estado.config;
  const cont = { disponivel: 0, aguardando: 0, analise: 0, pago: 0 };
  const lista = c ? faixaNumeros(c) : [];
  const agora = Date.now();
  lista.forEach((n) => { cont[statusPublico(estado.numeros.get(String(n)), c, agora)]++; });

  // Valor confirmado: somente reservas aprovadas pela equipe.
  const confirmado = estado.reservas
    .filter((r) => r.status === "pago")
    .reduce((soma, r) => soma + (Number(r.valor) || 0), 0);

  $("indTotal").textContent = lista.length;
  $("indDisp").textContent = cont.disponivel;
  $("indAgu").textContent = cont.aguardando;
  $("indAna").textContent = cont.analise;
  $("indPago").textContent = cont.pago;
  $("indValor").textContent = formatarMoeda(confirmado);

  const expiradas = reservasParaLiberar();
  const btn = $("btnLiberarExpiradas");
  btn.hidden = expiradas.length === 0;
  btn.textContent = `Liberar reservas expiradas (${expiradas.length})`;
}

function reservasParaLiberar() {
  return estado.reservas.filter((r) => {
    if (r.status !== "aguardando") return false;
    const c = contexto(r);
    return c.vencida || !c.ativo;
  });
}

// ---------------------------------------------------------------------------
// Tabela e filtros
// ---------------------------------------------------------------------------

const normalizar = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

["fNumero", "fNome", "fTelefone", "fStatus"].forEach((id) => $(id).addEventListener("input", renderTabela));

function filtrar() {
  const fNum = $("fNumero").value.trim();
  const fNome = normalizar($("fNome").value.trim());
  const fTel = $("fTelefone").value.replace(/\D/g, "");
  const fStatus = $("fStatus").value;
  return estado.reservas.filter((r) => {
    if (fNum !== "" && String(r.numero) !== String(Number(fNum))) return false;
    if (fNome && !normalizar(r.nome).includes(fNome)) return false;
    if (fTel && !String(r.telefone || "").replace(/\D/g, "").includes(fTel)) return false;
    if (fStatus === "ativas" && FINAIS.includes(r.status)) return false;
    if (!["ativas", "todas"].includes(fStatus) && r.status !== fStatus) return false;
    return true;
  });
}

function seloStatus(r) {
  const c = contexto(r);
  let alerta = "";
  if (!FINAIS.includes(r.status) && !c.ativo) alerta = `<br><span class="selo selo-alerta">Número não está mais com esta reserva</span>`;
  else if (c.vencida) alerta = `<br><span class="selo selo-alerta">Prazo expirado</span>`;
  return `<span class="selo selo-${r.status}">${escapeHtml(STATUS_RESERVA[r.status] || r.status)}</span>${alerta}`;
}

function botoesAcoes(r, pequeno = true) {
  const c = contexto(r);
  const tam = pequeno ? " botao-pequeno" : "";
  const botoes = Object.entries(ACOES)
    .filter(([, a]) => a.pode(r, c))
    .map(([chave, a]) => `<button type="button" class="botao ${a.classe}${tam}" data-acao="${chave}" data-id="${r.id}">${a.rotulo}</button>`);
  if (pequeno) botoes.unshift(`<button type="button" class="botao botao-secundario${tam}" data-detalhes="${r.id}">Detalhes</button>`);
  return botoes.join("");
}

function renderTabela() {
  if (!estado.usuario) return;
  const lista = filtrar();
  $("tabelaCorpo").innerHTML = lista.map((r) => {
    const wa = linkWhatsApp(r.telefone);
    const comp = r.comprovanteId
      ? `${escapeHtml(r.comprovanteId)}${r.referencia ? `<br><span class="ajuda">Ref.: ${escapeHtml(r.referencia)}</span>` : ""}${r.arquivo ? `<br><span class="ajuda">📎 arquivo anexado</span>` : ""}`
      : `<span class="ajuda">—</span>`;
    return `<tr class="${FINAIS.includes(r.status) ? "inativa" : ""}">
      <td data-rotulo="Número" class="num-col">${formatarNumero(r.numero)}</td>
      <td data-rotulo="Nome" class="quebra">${escapeHtml(r.nome)}</td>
      <td data-rotulo="Telefone">${wa ? `<a href="${wa}" target="_blank" rel="noopener">${escapeHtml(r.telefone)}</a>` : escapeHtml(r.telefone)}</td>
      <td data-rotulo="Reserva">${formatarDataHora(r.criadaEm)}</td>
      <td data-rotulo="Valor">${formatarMoeda(r.valor)}</td>
      <td data-rotulo="Comprovante" class="quebra">${comp}</td>
      <td data-rotulo="Status">${seloStatus(r)}</td>
      <td data-rotulo="Ações"><div class="acoes">${botoesAcoes(r)}</div></td>
    </tr>`;
  }).join("");
  $("tabelaVazia").hidden = lista.length > 0;
  $("tabelaContagem").textContent = `${lista.length} de ${estado.reservas.length} reserva(s).`;
}

document.addEventListener("click", (e) => {
  const det = e.target.closest("[data-detalhes]");
  if (det) { abrirDetalhes(det.dataset.detalhes); return; }
  const btn = e.target.closest("[data-acao]");
  if (btn) {
    const r = estado.reservas.find((x) => x.id === btn.dataset.id);
    if (r) pedirConfirmacao(r, btn.dataset.acao);
  }
});

document.querySelectorAll("dialog").forEach((dlg) => {
  dlg.addEventListener("click", (e) => { if (e.target.closest("[data-fechar]")) dlg.close(); });
});
$("dlgDetalhes").addEventListener("close", () => { estado.detalheId = null; });

// ---------------------------------------------------------------------------
// Ações operacionais
// ---------------------------------------------------------------------------

function pedirConfirmacao(r, acao) {
  const a = ACOES[acao];
  if (!a) return;
  estado.acaoPendente = { reserva: r, acao };
  $("confTitulo").textContent = a.rotulo;
  $("confTexto").textContent = a.texto(r);
  $("confObs").value = "";
  $("confErro").hidden = true;
  const btn = $("btnConfirmarAcao");
  btn.disabled = false;
  btn.textContent = a.rotulo;
  btn.className = `botao ${a.classe === "botao-perigo" ? "botao-perigo" : "botao-primario"}`;
  $("dlgConfirmar").showModal();
}

$("formConfirmar").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pend = estado.acaoPendente;
  if (!pend) return;
  const btn = $("btnConfirmarAcao");
  btn.disabled = true;
  btn.textContent = "Salvando…";
  try {
    await executarAcao(pend.reserva, pend.acao, $("confObs").value.trim());
    $("dlgConfirmar").close();
    toast(`${ACOES[pend.acao].rotulo}: número ${formatarNumero(pend.reserva.numero)} atualizado.`, "sucesso");
  } catch (err) {
    console.error(err);
    $("confErro").textContent = err.codigo === "ESTADO_MUDOU"
      ? "A reserva foi alterada por outro operador ou pelo participante. Feche, confira os dados atualizados e tente novamente."
      : mensagemErro(err);
    $("confErro").hidden = false;
    btn.disabled = false;
    btn.textContent = ACOES[pend.acao].rotulo;
  }
});

function codigo(c) {
  const e = new Error(c);
  e.codigo = c;
  return e;
}

/**
 * Executa uma ação em transação: relê o estado atual da reserva e do número,
 * valida se a ação ainda é permitida e grava reserva + número + histórico juntos.
 */
async function executarAcao(reserva, acao, observacao) {
  const a = ACOES[acao];
  const usuario = estado.usuario;
  const resRef = doc(db, "reservas", reserva.id);
  const numRef = doc(db, "numeros", String(reserva.numero));

  await runTransaction(db, async (tx) => {
    const rs = await tx.get(resRef);
    const ns = await tx.get(numRef);
    if (!rs.exists()) throw codigo("ESTADO_MUDOU");
    const atual = { id: rs.id, ...rs.data() };
    const num = ns.exists() ? ns.data() : null;
    const c = contexto(atual, num);
    if (!a.pode(atual, c)) throw codigo("ESTADO_MUDOU");

    let obsHistorico = observacao;
    if (acao === "invalido" && atual.comprovanteId) {
      obsHistorico = [observacao, `Comprovante informado: ${atual.comprovanteId}${atual.referencia ? ` / ${atual.referencia}` : ""}`]
        .filter(Boolean).join(" — ");
    }

    const histRef = doc(collection(db, "historico"));
    tx.set(histRef, {
      reservaId: atual.id,
      numero: atual.numero,
      acao,
      statusAnterior: atual.status,
      statusNovo: a.novo,
      por: usuario.email,
      porUid: usuario.uid,
      em: serverTimestamp(),
      observacao: obsHistorico.slice(0, 500)
    });
    tx.update(resRef, {
      status: a.novo,
      observacao: observacao.slice(0, 500),
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuario.email,
      ultimoHistorico: histRef.id
    });
    if (c.ativo) {
      if (FINAIS.includes(a.novo)) {
        tx.delete(numRef);
      } else {
        const dados = { status: STATUS_NUMERO_PARA[a.novo] };
        // Pagamento não identificado: novo prazo para o participante reenviar o comprovante.
        if (a.novo === "invalido") dados.reservadoEm = serverTimestamp();
        tx.update(numRef, dados);
      }
    }
  });
}

$("btnLiberarExpiradas").addEventListener("click", async () => {
  const lista = reservasParaLiberar();
  if (!lista.length) return;
  const nums = lista.map((r) => formatarNumero(r.numero)).join(", ");
  if (!confirm(`Liberar ${lista.length} reserva(s) com prazo expirado e sem comprovante?\n\nNúmeros: ${nums}`)) return;
  const btn = $("btnLiberarExpiradas");
  btn.disabled = true;
  let ok = 0;
  let falhas = 0;
  for (const r of lista) {
    try {
      await executarAcao(r, "liberar", "Liberação de reservas expiradas");
      ok++;
    } catch (e) {
      console.error(e);
      falhas++;
    }
  }
  btn.disabled = false;
  toast(`${ok} reserva(s) liberada(s)${falhas ? `; ${falhas} não puderam ser liberadas (estado alterado)` : ""}.`, falhas ? "erro" : "sucesso");
});

// ---------------------------------------------------------------------------
// Detalhes da reserva
// ---------------------------------------------------------------------------

function abrirDetalhes(id) {
  estado.detalheId = id;
  renderDetalhes(id, true);
  if (!$("dlgDetalhes").open) $("dlgDetalhes").showModal();
}

async function renderDetalhes(id, carregarHistorico) {
  const r = estado.reservas.find((x) => x.id === id);
  if (!r) return;
  const c = contexto(r);
  const wa = linkWhatsApp(r.telefone);
  $("detTitulo").textContent = `Número ${formatarNumero(r.numero)}`;
  const linhas = [
    ["Status", seloStatus(r)],
    ["Nome completo", escapeHtml(r.nome)],
    ["Telefone/WhatsApp", wa ? `<a href="${wa}" target="_blank" rel="noopener">${escapeHtml(r.telefone)}</a>` : escapeHtml(r.telefone)],
    ["Valor esperado", formatarMoeda(r.valor)],
    ["Reserva feita em", formatarDataHora(r.criadaEm)],
    ["Prazo da reserva", c.fim ? formatarDataHora(c.fim) : "—"],
    ["Comprovante (ID)", escapeHtml(r.comprovanteId || "—")],
    ["Referência", escapeHtml(r.referencia || "—")],
    ["Comprovante enviado em", formatarDataHora(r.comprovanteEnviadoEm)],
    ["Arquivo", r.arquivo ? `<button type="button" class="botao botao-secundario botao-pequeno" id="btnAbrirArquivo">Abrir arquivo</button>` : "—"],
    ["Última alteração", r.atualizadoPor ? `${formatarDataHora(r.atualizadoEm)} por ${escapeHtml(r.atualizadoPor)}` : "—"],
    ["Observação", escapeHtml(r.observacao || "—")],
    ["ID da reserva", `<code>${escapeHtml(r.id)}</code>`]
  ];
  $("detDados").innerHTML = linhas.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  $("detAcoes").innerHTML = botoesAcoes(r, false);
  $("btnAbrirArquivo")?.addEventListener("click", () => abrirArquivo(r.arquivo));

  if (!carregarHistorico && $("detHistorico").dataset.id === id && $("detHistorico").dataset.ultimo === (r.ultimoHistorico || "")) return;
  $("detHistorico").dataset.id = id;
  $("detHistorico").dataset.ultimo = r.ultimoHistorico || "";
  $("detHistorico").innerHTML = `<li class="ajuda">Carregando…</li>`;

  const eventos = [{ em: emMs(r.criadaEm), texto: "Reserva criada pelo participante." }];
  if (r.comprovanteEnviadoEm) eventos.push({ em: emMs(r.comprovanteEnviadoEm), texto: "Comprovante enviado pelo participante (último envio)." });
  try {
    const snap = await getDocs(query(collection(db, "historico"), where("reservaId", "==", id)));
    snap.forEach((d) => {
      const h = d.data();
      eventos.push({
        em: emMs(h.em),
        texto: `${ACOES[h.acao]?.rotulo || h.acao}: ${STATUS_RESERVA[h.statusAnterior] || h.statusAnterior} → ${STATUS_RESERVA[h.statusNovo] || h.statusNovo}. Por ${h.por}.${h.observacao ? ` Obs.: ${h.observacao}` : ""}`
      });
    });
  } catch (e) {
    console.error(e);
    eventos.push({ em: Date.now(), texto: "Não foi possível carregar o histórico completo." });
  }
  if (estado.detalheId !== id) return;
  eventos.sort((a, b) => (a.em || 0) - (b.em || 0));
  $("detHistorico").innerHTML = eventos
    .map((ev) => `<li><strong>${formatarDataHora(ev.em)}</strong> — ${escapeHtml(ev.texto)}</li>`).join("");
}

async function abrirArquivo(caminho) {
  const janela = window.open("", "_blank");
  try {
    const url = await getDownloadURL(refStorage(obterStorage(), caminho));
    if (janela) janela.location = url; else location.href = url;
  } catch (e) {
    console.error(e);
    janela?.close();
    toast("Não foi possível abrir o arquivo.", "erro");
  }
}

// ---------------------------------------------------------------------------
// Configuração da rifa
// ---------------------------------------------------------------------------

let configCarregada = false;

function preencherConfig() {
  const c = estado.config;
  if (!c) {
    $("secConfig").open = true;
    $("configInfo").textContent = "A rifa ainda não está configurada. Preencha e salve para liberar as reservas.";
    if (!configCarregada) {
      $("cTitulo").value = "Rifa Online";
      $("cValor").value = "10,00";
      $("cMinutos").value = 30;
      $("cInicial").value = 0;
      $("cFinal").value = 100;
      configCarregada = true;
    }
    return;
  }
  $("configInfo").textContent = c.atualizadoPor ? `Última alteração: ${formatarDataHora(c.atualizadoEm)} por ${c.atualizadoPor}.` : "";
  // Não sobrescreve o que o operador está editando.
  if (configCarregada && $("formConfig").contains(document.activeElement)) return;
  $("cTitulo").value = c.titulo || "";
  $("cDescricao").value = c.descricao || "";
  $("cValor").value = Number(c.valor || 0).toFixed(2).replace(".", ",");
  $("cMinutos").value = c.reservaMinutos ?? 30;
  $("cInicial").value = c.numeroInicial ?? 0;
  $("cFinal").value = c.numeroFinal ?? 100;
  $("cPixChave").value = c.pixChave || "";
  $("cPixNome").value = c.pixNome || "";
  $("cPixCidade").value = c.pixCidade || "";
  $("cPixCodigo").value = c.pixCopiaECola || "";
  $("cQrUrl").value = c.qrCodeUrl || "";
  $("cContato").value = c.contato || "";
  $("cArquivo").checked = Boolean(c.permitirArquivo);
  configCarregada = true;
}

$("formConfig").addEventListener("submit", async (e) => {
  e.preventDefault();
  const erro = $("configErro");
  erro.hidden = true;
  const valor = Number($("cValor").value.replace(/\./g, "").replace(",", "."));
  const minutos = parseInt($("cMinutos").value, 10);
  const inicial = parseInt($("cInicial").value, 10);
  const final = parseInt($("cFinal").value, 10);
  const titulo = $("cTitulo").value.trim();

  const problema =
    !titulo ? "Informe o título." :
    !(valor > 0) ? "Informe um valor válido (ex.: 10,00)." :
    !(minutos >= 1 && minutos <= 10080) ? "O prazo deve ser entre 1 e 10080 minutos." :
    !(inicial >= 0 && final >= inicial && final <= 9999) ? "Faixa de números inválida." :
    null;
  if (problema) { erro.textContent = problema; erro.hidden = false; return; }

  const foraDaFaixa = [...estado.numeros.keys()].map(Number).filter((n) => n < inicial || n > final);
  if (foraDaFaixa.length && !confirm(`Os números ${foraDaFaixa.join(", ")} têm reservas e ficarão fora da nova faixa. Continuar mesmo assim?`)) return;

  const btn = $("btnSalvarConfig");
  btn.disabled = true;
  btn.textContent = "Salvando…";
  try {
    await setDoc(doc(db, "config", "rifa"), {
      titulo,
      descricao: $("cDescricao").value.trim(),
      valor: Math.round(valor * 100) / 100,
      numeroInicial: inicial,
      numeroFinal: final,
      reservaMinutos: minutos,
      pixChave: $("cPixChave").value.trim(),
      pixNome: $("cPixNome").value.trim(),
      pixCidade: $("cPixCidade").value.trim(),
      pixCopiaECola: $("cPixCodigo").value.trim(),
      qrCodeUrl: $("cQrUrl").value.trim(),
      contato: $("cContato").value.trim(),
      permitirArquivo: $("cArquivo").checked,
      atualizadoEm: serverTimestamp(),
      atualizadoPor: estado.usuario.email
    });
    document.activeElement?.blur();
    toast("Configuração salva.", "sucesso");
  } catch (err) {
    console.error(err);
    erro.textContent = mensagemErro(err);
    erro.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Salvar configuração";
  }
});
