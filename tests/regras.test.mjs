// Testes das regras do Firestore e do Storage contra os emuladores do Firebase.
// Execute com:  npm test   (veja o README)

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment, assertSucceeds, assertFails
} from "@firebase/rules-unit-testing";
import {
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, runTransaction,
  serverTimestamp, Timestamp, query, where
} from "firebase/firestore";
import { ref, uploadBytes, getBytes } from "firebase/storage";

const PROJETO = "demo-rifa-testes";
let env;

const CONFIG = {
  titulo: "Rifa de teste", descricao: "", valor: 10, numeroInicial: 0, numeroFinal: 100,
  reservaMinutos: 30, pixChave: "pix@exemplo.com", pixNome: "Fulano", pixCidade: "Sao Paulo",
  pixCopiaECola: "", qrCodeUrl: "", permitirArquivo: true, contato: "", dataSorteio: "30/11/26", mostrarQrCode: false,
  atualizadoEm: Timestamp.now(), atualizadoPor: "admin@rifa.test"
};

const anonimo = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: "anonymous" } }).firestore();
const admin = () => env.authenticatedContext("adm1", { email: "admin@rifa.test", firebase: { sign_in_provider: "password" } }).firestore();
const naoAdmin = () => env.authenticatedContext("intruso", { email: "intruso@rifa.test", firebase: { sign_in_provider: "password" } }).firestore();
const publico = () => env.unauthenticatedContext().firestore();

/** Mesma operação feita pelo app.js: cria reserva + vínculo do número de forma atômica. */
function dadosReserva(uid, numero, extra = {}) {
  return { numero, nome: "Maria Silva", telefone: "(11) 91234-5678", uid, valor: 10, status: "aguardando", criadaEm: serverTimestamp(), ...extra };
}

async function reservar(db, uid, numero, extra = {}) {
  const resRef = doc(collection(db, "reservas"));
  const b = writeBatch(db);
  b.set(resRef, dadosReserva(uid, numero, extra));
  b.set(doc(db, "numeros", String(numero)), { status: "aguardando", reservaId: resRef.id, reservadoEm: serverTimestamp() });
  await b.commit();
  return resRef.id;
}

async function enviarComprovante(db, reservaId, numero, extra = {}) {
  const b = writeBatch(db);
  b.update(doc(db, "reservas", reservaId), {
    status: "analise", comprovanteId: "E2E123456", referencia: "", arquivo: "", comprovanteEnviadoEm: serverTimestamp(), ...extra
  });
  b.update(doc(db, "numeros", String(numero)), { status: "analise" });
  return b.commit();
}

/** Mesma operação feita pelo admin.js. */
async function acaoAdmin(db, email, uid, reservaId, numero, statusAnterior, statusNovo, opcoes = {}) {
  const hRef = doc(collection(db, "historico"));
  const b = writeBatch(db);
  if (!opcoes.semHistorico) {
    b.set(hRef, { reservaId, numero, acao: "teste", statusAnterior, statusNovo, por: email, porUid: uid, em: serverTimestamp(), observacao: "" });
  }
  b.update(doc(db, "reservas", reservaId), {
    status: statusNovo, observacao: "", atualizadoEm: serverTimestamp(), atualizadoPor: email, ultimoHistorico: hRef.id
  });
  const numRef = doc(db, "numeros", String(numero));
  if (statusNovo === "cancelada" || statusNovo === "expirada") b.delete(numRef);
  else if (!opcoes.semNumero) b.update(numRef, { status: { invalido: "aguardando" }[statusNovo] || statusNovo });
  return b.commit();
}

/** Simula a passagem do tempo: recua o horário da reserva do número. */
async function envelhecer(numero, minutos) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), "numeros", String(numero)), {
      reservadoEm: Timestamp.fromMillis(Date.now() - minutos * 60000)
    });
  });
}

before(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
  const [shost, sport] = (process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199").split(":");
  env = await initializeTestEnvironment({
    projectId: PROJETO,
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host, port: Number(port) },
    storage: { rules: readFileSync("storage.rules", "utf8"), host: shost, port: Number(sport) }
  });
});

after(async () => { await env?.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "config", "rifa"), CONFIG);
    await setDoc(doc(db, "admins", "adm1"), { email: "admin@rifa.test" });
  });
});

// ---------------------------------------------------------------------------

test("visitante lê configuração e números, mas não reservas, histórico ou admins", async () => {
  const db = publico();
  await assertSucceeds(getDoc(doc(db, "config", "rifa")));
  await assertSucceeds(getDocs(collection(db, "numeros")));
  await assertFails(getDocs(collection(db, "reservas")));
  await assertFails(getDocs(collection(db, "historico")));
  await assertFails(getDoc(doc(db, "admins", "adm1")));
});

test("participante reserva um número disponível", async () => {
  const db = anonimo("ana");
  const id = await assertSucceeds(reservar(db, "ana", 7));
  const num = (await getDoc(doc(publico(), "numeros", "7"))).data();
  assert.equal(num.status, "aguardando");
  assert.equal(num.reservaId, id);
  assert.deepEqual(Object.keys(num).sort(), ["reservaId", "reservadoEm", "status"], "número público não expõe dados pessoais");
});

test("visitante sem login não reserva", async () => {
  await assertFails(reservar(publico(), "x", 3));
});

test("segundo participante não reserva número já reservado", async () => {
  await reservar(anonimo("ana"), "ana", 7);
  await assertFails(reservar(anonimo("bia"), "bia", 7));
});

test("duas reservas simultâneas do mesmo número: somente uma é gravada", async () => {
  const resultados = await Promise.allSettled([
    reservar(anonimo("ana"), "ana", 42),
    reservar(anonimo("bia"), "bia", 42),
    reservar(anonimo("caio"), "caio", 42)
  ]);
  const ok = resultados.filter((r) => r.status === "fulfilled");
  assert.equal(ok.length, 1, `esperado 1 sucesso, obtido ${ok.length}`);
  await env.withSecurityRulesDisabled(async (ctx) => {
    const reservas = await getDocs(query(collection(ctx.firestore(), "reservas"), where("numero", "==", 42)));
    assert.equal(reservas.size, 1, "apenas uma reserva do número 42 deve existir");
  });
});

test("transações simultâneas (fluxo do app) também não duplicam", async () => {
  const tentar = (uid) => {
    const db = anonimo(uid);
    const resRef = doc(collection(db, "reservas"));
    const numRef = doc(db, "numeros", "50");
    return runTransaction(db, async (tx) => {
      const s = await tx.get(numRef);
      if (s.exists()) throw new Error("INDISPONIVEL");
      tx.set(resRef, dadosReserva(uid, 50));
      tx.set(numRef, { status: "aguardando", reservaId: resRef.id, reservadoEm: serverTimestamp() });
    });
  };
  const r = await Promise.allSettled([tentar("u1"), tentar("u2"), tentar("u3"), tentar("u4")]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
});

test("reserva inválida é recusada (valor, status, faixa, campos extras, outro uid)", async () => {
  const db = anonimo("ana");
  await assertFails(reservar(db, "ana", 1, { valor: 1 }));
  await assertFails(reservar(db, "ana", 2, { status: "pago" }));
  await assertFails(reservar(db, "ana", 101));
  await assertFails(reservar(db, "ana", 3, { admin: true }));
  await assertFails(reservar(db, "outra", 4));
  await assertFails(reservar(db, "ana", 5, { nome: "A" }));
});

test("número não pode ser criado sem a reserva correspondente", async () => {
  const db = anonimo("ana");
  await assertFails(setDoc(doc(db, "numeros", "9"), { status: "aguardando", reservaId: "inexistente", reservadoEm: serverTimestamp() }));
  await assertFails(setDoc(doc(db, "numeros", "09"), { status: "aguardando", reservaId: "x", reservadoEm: serverTimestamp() }));
});

test("participante não confirma o próprio pagamento", async () => {
  const db = anonimo("ana");
  const id = await reservar(db, "ana", 7);
  await assertFails(updateDoc(doc(db, "numeros", "7"), { status: "pago" }));
  await assertFails(updateDoc(doc(db, "reservas", id), { status: "pago" }));
  await enviarComprovante(db, id, 7);
  await assertFails(updateDoc(doc(db, "numeros", "7"), { status: "pago" }));
  await assertFails(deleteDoc(doc(db, "numeros", "7")));
});

test("participante lê apenas a própria reserva", async () => {
  const id = await reservar(anonimo("ana"), "ana", 7);
  await assertSucceeds(getDoc(doc(anonimo("ana"), "reservas", id)));
  await assertSucceeds(getDocs(query(collection(anonimo("ana"), "reservas"), where("uid", "==", "ana"))));
  await assertFails(getDoc(doc(anonimo("bia"), "reservas", id)));
  await assertFails(getDocs(collection(anonimo("bia"), "reservas")));
});

test("envio do comprovante muda para análise; outro usuário não envia; não reenvia em análise", async () => {
  const db = anonimo("ana");
  const id = await reservar(db, "ana", 7);
  await assertFails(enviarComprovante(anonimo("bia"), id, 7));
  await assertFails(enviarComprovante(db, id, 7, { comprovanteId: "" }));
  await assertSucceeds(enviarComprovante(db, id, 7));
  assert.equal((await getDoc(doc(publico(), "numeros", "7"))).data().status, "analise");
  await assertFails(enviarComprovante(db, id, 7, { comprovanteId: "OUTRO" }));
});

test("reserva expirada SEM comprovante pode ser assumida por outro participante", async () => {
  const idAna = await reservar(anonimo("ana"), "ana", 7);
  await assertFails(reservar(anonimo("bia"), "bia", 7)); // ainda no prazo
  await envelhecer(7, 31);
  const idBia = await assertSucceeds(reservar(anonimo("bia"), "bia", 7));
  assert.notEqual(idAna, idBia);
  // A participante antiga não consegue mais enviar comprovante para o número.
  await assertFails(enviarComprovante(anonimo("ana"), idAna, 7));
});

test("reserva COM comprovante (em análise) nunca é liberada automaticamente", async () => {
  const db = anonimo("ana");
  const id = await reservar(db, "ana", 7);
  await enviarComprovante(db, id, 7);
  await envelhecer(7, 600);
  await assertFails(reservar(anonimo("bia"), "bia", 7));
});

test("participante com prazo vencido (ainda não assumido) pode enviar comprovante", async () => {
  const db = anonimo("ana");
  const id = await reservar(db, "ana", 7);
  await envelhecer(7, 45);
  await assertSucceeds(enviarComprovante(db, id, 7));
});

test("admin confirma pagamento com registro no histórico", async () => {
  const p = anonimo("ana");
  const id = await reservar(p, "ana", 7);
  await enviarComprovante(p, id, 7);
  const a = admin();
  await assertSucceeds(getDocs(collection(a, "reservas")));
  await assertSucceeds(acaoAdmin(a, "admin@rifa.test", "adm1", id, 7, "analise", "pago"));
  assert.equal((await getDoc(doc(publico(), "numeros", "7"))).data().status, "pago");
  const hist = await getDocs(query(collection(a, "historico"), where("reservaId", "==", id)));
  assert.equal(hist.size, 1);
  assert.equal(hist.docs[0].data().por, "admin@rifa.test");
});

test("admin não altera status sem histórico, com e-mail falso ou alterando dados pessoais", async () => {
  const id = await reservar(anonimo("ana"), "ana", 7);
  const a = admin();
  await assertFails(acaoAdmin(a, "admin@rifa.test", "adm1", id, 7, "aguardando", "pago", { semHistorico: true }));
  await assertFails(acaoAdmin(a, "outro@rifa.test", "adm1", id, 7, "aguardando", "pago"));
  await assertFails(updateDoc(doc(a, "reservas", id), { nome: "Outro Nome" }));
});

test("usuário autenticado que não é admin e usuário anônimo não executam ações administrativas", async () => {
  const id = await reservar(anonimo("ana"), "ana", 7);
  await assertFails(getDocs(collection(naoAdmin(), "reservas")));
  await assertFails(acaoAdmin(naoAdmin(), "intruso@rifa.test", "intruso", id, 7, "aguardando", "pago"));
  // Anônimo com o mesmo uid de um admin não é admin.
  const falsoAdmin = env.authenticatedContext("adm1", { email: "admin@rifa.test", firebase: { sign_in_provider: "anonymous" } }).firestore();
  await assertFails(acaoAdmin(falsoAdmin, "admin@rifa.test", "adm1", id, 7, "aguardando", "pago"));
  await assertFails(setDoc(doc(naoAdmin(), "admins", "intruso"), { email: "intruso@rifa.test" }));
});

test("admin cancela/libera: número volta a ficar disponível; exclusão exige reserva encerrada", async () => {
  const id = await reservar(anonimo("ana"), "ana", 7);
  const a = admin();
  await assertFails(deleteDoc(doc(a, "numeros", "7")));
  await assertSucceeds(acaoAdmin(a, "admin@rifa.test", "adm1", id, 7, "aguardando", "cancelada"));
  assert.equal((await getDoc(doc(publico(), "numeros", "7"))).exists(), false);
  await assertSucceeds(reservar(anonimo("bia"), "bia", 7));
});

test("pagamento não identificado: participante pode reenviar o comprovante", async () => {
  const p = anonimo("ana");
  const id = await reservar(p, "ana", 7);
  await enviarComprovante(p, id, 7);
  await assertSucceeds(acaoAdmin(admin(), "admin@rifa.test", "adm1", id, 7, "analise", "invalido"));
  assert.equal((await getDoc(doc(publico(), "numeros", "7"))).data().status, "aguardando");
  await assertSucceeds(enviarComprovante(p, id, 7, { comprovanteId: "NOVO-ID-999" }));
});

test("histórico não pode ser alterado nem apagado", async () => {
  const id = await reservar(anonimo("ana"), "ana", 7);
  const a = admin();
  await acaoAdmin(a, "admin@rifa.test", "adm1", id, 7, "aguardando", "analise");
  const h = (await getDocs(collection(a, "historico"))).docs[0];
  await assertFails(updateDoc(h.ref, { por: "x" }));
  await assertFails(deleteDoc(h.ref));
});

test("configuração: somente admin altera, com validação", async () => {
  const novo = { ...CONFIG, valor: 15, atualizadoEm: serverTimestamp(), atualizadoPor: "admin@rifa.test" };
  await assertFails(setDoc(doc(anonimo("ana"), "config", "rifa"), novo));
  await assertFails(setDoc(doc(naoAdmin(), "config", "rifa"), { ...novo, atualizadoPor: "intruso@rifa.test" }));
  await assertSucceeds(setDoc(doc(admin(), "config", "rifa"), novo));
  await assertFails(setDoc(doc(admin(), "config", "rifa"), { ...novo, valor: -1 }));
  await assertFails(setDoc(doc(admin(), "config", "outra"), novo));
});

test("storage: participante envia comprovante; somente admin lê", async () => {
  const id = await reservar(anonimo("ana"), "ana", 7);
  const caminho = `comprovantes/ana/${id}/comp.png`;
  const arquivo = new Uint8Array([137, 80, 78, 71]);
  const stAna = env.authenticatedContext("ana", { firebase: { sign_in_provider: "anonymous" } }).storage();
  await assertSucceeds(uploadBytes(ref(stAna, caminho), arquivo, { contentType: "image/png" }));
  await assertFails(getBytes(ref(stAna, caminho)));
  await assertFails(uploadBytes(ref(stAna, `comprovantes/ana/${id}/x.exe`), arquivo, { contentType: "application/x-msdownload" }));
  const stBia = env.authenticatedContext("bia", { firebase: { sign_in_provider: "anonymous" } }).storage();
  await assertFails(uploadBytes(ref(stBia, `comprovantes/ana/${id}/b.png`), arquivo, { contentType: "image/png" }));
  const stAdm = env.authenticatedContext("adm1", { email: "admin@rifa.test", firebase: { sign_in_provider: "password" } }).storage();
  await assertSucceeds(getBytes(ref(stAdm, caminho)));
});
