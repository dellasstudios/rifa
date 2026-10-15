// Geração do "Pix Copia e Cola" (BR Code estático, padrão EMV do Banco Central).

function campo(id, valor) {
  const v = String(valor);
  return id + String(v.length).padStart(2, "0") + v;
}

/** CRC16-CCITT (polinômio 0x1021, valor inicial 0xFFFF), exigido pelo BR Code. */
export function crc16(texto) {
  let crc = 0xffff;
  for (let i = 0; i < texto.length; i++) {
    crc ^= texto.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function semAcentos(texto, max) {
  return String(texto || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .toUpperCase().trim().slice(0, max);
}

function cpfValido(d) {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  for (const t of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(d[i]) * (t + 1 - i);
    const dv = (soma * 10) % 11 % 10;
    if (dv !== Number(d[t])) return false;
  }
  return true;
}

/**
 * Converte a chave digitada para o formato exigido no BR Code e informa o tipo.
 * Celular precisa ir como +55DDDNÚMERO; CPF/CNPJ só com dígitos.
 * @returns {{chave:string, tipo:string}}
 */
export function normalizarChavePix(chaveDigitada) {
  const bruta = String(chaveDigitada || "").trim();
  if (!bruta) return { chave: "", tipo: "" };
  if (bruta.includes("@")) return { chave: bruta.toLowerCase(), tipo: "E-mail" };
  if (/^[\d\s().+\-/]+$/.test(bruta)) {
    const d = bruta.replace(/\D/g, "");
    if (bruta.startsWith("+")) return { chave: "+" + d, tipo: "Celular" };
    if (d.length === 11 && cpfValido(d)) return { chave: d, tipo: "CPF" };
    if (d.length === 14) return { chave: d, tipo: "CNPJ" };
    if (d.length === 10 || d.length === 11) return { chave: "+55" + d, tipo: "Celular" };
    if ((d.length === 12 || d.length === 13) && d.startsWith("55")) return { chave: "+" + d, tipo: "Celular" };
  }
  return { chave: bruta.toLowerCase(), tipo: "Chave aleatória" };
}

/**
 * Monta o código Pix copia e cola.
 * @param {{chave:string, nome:string, cidade:string, valor?:number, txid?:string}} dados
 */
export function gerarPixCopiaECola({ chave, nome, cidade, valor, txid }) {
  const conta = campo("00", "br.gov.bcb.pix") + campo("01", normalizarChavePix(chave).chave);
  const id = String(txid || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***";

  let payload = campo("00", "01")
    + campo("26", conta)
    + campo("52", "0000")
    + campo("53", "986");
  if (valor > 0) payload += campo("54", Number(valor).toFixed(2));
  payload += campo("58", "BR")
    + campo("59", semAcentos(nome, 25) || "RECEBEDOR")
    + campo("60", semAcentos(cidade, 15) || "BRASIL")
    + campo("62", campo("05", id))
    + "6304";
  return payload + crc16(payload);
}
