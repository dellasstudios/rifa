// Inicialização e conexão com o Firebase (Auth, Firestore e Storage).
// Todas as funções do SDK usadas pelo app são reexportadas daqui, para que a
// versão do SDK fique definida em um único lugar.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getStorage, connectStorageEmulator } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { firebaseConfig } from "./firebase-config.js";

export {
  onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

export {
  doc, collection, getDoc, getDocs, onSnapshot, query, where, orderBy,
  runTransaction, serverTimestamp, setDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

export { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";

const local = ["localhost", "127.0.0.1"].includes(location.hostname);

/** Projeto de demonstração (projectId "demo-...") -> usa os emuladores locais. */
export const modoEmulador = firebaseConfig.projectId.startsWith("demo-");

/** false quando o site publicado ainda está com a configuração de exemplo. */
export const firebaseConfigurado = !modoEmulador || local;

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

if (modoEmulador && local) {
  connectAuthEmulator(auth, `http://${location.hostname}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, location.hostname, 8080);
}

let storage = null;
/** O Storage só é inicializado quando realmente for usado (envio de arquivo). */
export function obterStorage() {
  if (!storage) {
    storage = getStorage(app);
    if (modoEmulador && local) connectStorageEmulator(storage, location.hostname, 9199);
  }
  return storage;
}
