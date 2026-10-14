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

/**
 * Monta o código Pix copia e cola.
 * @param {{chave:string, nome:string, cidade:string, valor?:number, txid?:string}} dados
 */
export function gerarPixCopiaECola({ chave, nome, cidade, valor, txid }) {
  const conta = campo("00", "br.gov.bcb.pix") + campo("01", String(chave).trim());
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
