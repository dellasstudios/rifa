// Utilitários compartilhados entre a página pública e o painel gerencial.

/** Estados exibidos publicamente na grade. */
export const STATUS_NUMERO = {
  disponivel: { rotulo: "Disponível", curto: "livre", icone: "" },
  aguardando: { rotulo: "Aguardando pagamento", curto: "reservado", icone: "⏳" },
  analise: { rotulo: "Pagamento em análise", curto: "em análise", icone: "🔎" },
  pago: { rotulo: "Pago / confirmado", curto: "pago", icone: "✔" }
};

/** Estados de uma reserva (visão administrativa e do participante). */
export const STATUS_RESERVA = {
  aguardando: "Aguardando pagamento",
  analise: "Pagamento em análise",
  pago: "Pago / confirmado",
  invalido: "Pagamento não identificado",
  cancelada: "Cancelada",
  expirada: "Expirada / liberada"
};

export function numeroOuZero(v) {
  return typeof v === "number" && isFinite(v) ? v : 0;
}

/** Converte Timestamp do Firestore (ou Date/ms) em milissegundos. */
export function emMs(t) {
  if (!t) return null;
  if (typeof t === "number") return t;
  if (t instanceof Date) return t.getTime();
  if (typeof t.toMillis === "function") return t.toMillis();
  return null;
}

/** Momento em que a reserva de um número expira (ms) ou null. */
export function expiraEm(numeroDoc, config) {
  const inicio = emMs(numeroDoc?.reservadoEm);
  if (inicio == null || !config) return null;
  return inicio + numeroOuZero(config.reservaMinutos) * 60000;
}

/** Status público efetivo de um número, considerando o prazo de reserva. */
export function statusPublico(numeroDoc, config, agora = Date.now()) {
  if (!numeroDoc) return "disponivel";
  if (numeroDoc.status === "aguardando") {
    const fim = expiraEm(numeroDoc, config);
    if (fim != null && agora > fim) return "disponivel";
  }
  return STATUS_NUMERO[numeroDoc.status] ? numeroDoc.status : "aguardando";
}

export function faixaNumeros(config) {
  const ini = numeroOuZero(config?.numeroInicial);
  const fim = Math.max(ini, numeroOuZero(config?.numeroFinal));
  const lista = [];
  for (let n = ini; n <= fim; n++) lista.push(n);
  return lista;
}

export function formatarNumero(n) {
  return String(n).padStart(2, "0");
}

const moeda = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export function formatarMoeda(v) {
  return moeda.format(numeroOuZero(v));
}

export function formatarDataHora(t) {
  const ms = emMs(t);
  if (ms == null) return "—";
  return new Date(ms).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export function formatarHora(t) {
  const ms = emMs(t);
  if (ms == null) return "—";
  return new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** Aplica máscara (99) 99999-9999 enquanto o usuário digita. */
export function mascararTelefone(valor) {
  const d = String(valor).replace(/\D/g, "").slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : "";
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

export function escapeHtml(texto) {
  return String(texto ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

/** Link de WhatsApp a partir de um telefone brasileiro. */
export function linkWhatsApp(telefone) {
  let d = String(telefone || "").replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) d = "55" + d;
  return d.length >= 12 ? `https://wa.me/${d}` : null;
}

let toastTimer = null;
export function toast(mensagem, tipo = "info") {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.textContent = mensagem;
  el.className = `toast toast-${tipo} visivel`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visivel"), 4500);
}

export async function copiarTexto(texto) {
  try {
    await navigator.clipboard.writeText(texto);
  } catch {
    const area = document.createElement("textarea");
    area.value = texto;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  toast("Copiado!", "sucesso");
}

/** Traduz erros do Firebase para mensagens amigáveis. */
export function mensagemErro(erro) {
  const code = erro?.code || erro?.message || "";
  if (code.includes("permission-denied")) return "Operação não permitida. Os dados podem ter sido alterados; atualize e tente novamente.";
  if (code.includes("unavailable") || code.includes("network") || code.includes("deadline-exceeded"))
    return "Falha de conexão. Verifique sua internet e tente novamente.";
  if (code.includes("failed-precondition") || code.includes("aborted"))
    return "Os dados mudaram durante a operação. Tente novamente.";
  return "Não foi possível concluir a operação. Tente novamente.";
}

export function legendaHtml() {
  return Object.entries(STATUS_NUMERO).map(([chave, s]) => `
    <li><span class="amostra st-${chave}" aria-hidden="true">${s.icone}</span> ${s.rotulo}</li>
  `).join("");
}
