// Prepara os emuladores locais com um administrador e a configuração inicial.
// Uso (com os emuladores rodando):  npm run seed
// Credenciais APENAS para o ambiente local de testes (emulador):
//   e-mail: admin@rifa.test   senha: rifa-teste-123

import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc, Timestamp } from "firebase/firestore";

const PROJETO = "demo-rifa";
const EMAIL = "admin@rifa.test";
const SENHA = "rifa-teste-123";
const AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";

async function chamar(rota, corpo) {
  const r = await fetch(`${AUTH}/${rota}?key=demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...corpo, returnSecureToken: true })
  });
  return r.json();
}

let conta = await chamar("accounts:signUp", { email: EMAIL, password: SENHA });
if (conta.error) conta = await chamar("accounts:signInWithPassword", { email: EMAIL, password: SENHA });
if (!conta.localId) throw new Error("Não foi possível criar o administrador: " + JSON.stringify(conta));

const env = await initializeTestEnvironment({ projectId: PROJETO, firestore: { host: "127.0.0.1", port: 8080 } });
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, "admins", conta.localId), { email: EMAIL });
  if (process.argv.includes("--config")) {
    await setDoc(doc(db, "config", "rifa"), {
      titulo: "Rifa Beneficente",
      descricao: "Concorra a uma cesta de produtos especiais. Sorteio após a venda de todos os números.",
      valor: 10, numeroInicial: 0, numeroFinal: 100, reservaMinutos: 30,
      pixChave: "rifa@exemplo.com", pixNome: "Organizacao da Rifa", pixCidade: "Sao Paulo",
      pixCopiaECola: "", qrCodeUrl: "", permitirArquivo: true, contato: "(11) 91234-5678",
      atualizadoEm: Timestamp.now(), atualizadoPor: EMAIL
    });
  }
});
await env.cleanup();
console.log(`Administrador local pronto: ${EMAIL} (uid ${conta.localId})`);
