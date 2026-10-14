# Rifa Online

Aplicação web simples para venda de números de rifa com pagamento via Pix e conferência manual pela equipe.

- **Página pública** (`index.html`): grade de números, reserva com nome e telefone, instruções de pagamento Pix (chave, código copia e cola e QR Code) e envio do comprovante.
- **Painel gerencial** (`admin.html`): acesso com login real (Firebase Authentication), indicadores, tabela de reservas com filtros, ações operacionais com confirmação e histórico, além da configuração da rifa.
- **Sem servidor próprio:** o site é estático (GitHub Pages) e os dados ficam no **Cloud Firestore**, sincronizados em tempo real entre todos os aparelhos.
- **Segurança no banco:** as regras em [`firestore.rules`](firestore.rules) impedem reservas duplicadas, impedem que o participante confirme o próprio pagamento e restringem os dados pessoais aos administradores.

---

## Sumário

1. [Estrutura do projeto](#1-estrutura-do-projeto)
2. [Como funciona](#2-como-funciona)
3. [Configurar o Firebase](#3-configurar-o-firebase)
4. [Publicar no GitHub Pages](#4-publicar-no-github-pages)
5. [Primeiro acesso e configuração da rifa](#5-primeiro-acesso-e-configuração-da-rifa)
6. [Uso no dia a dia (equipe operacional)](#6-uso-no-dia-a-dia-equipe-operacional)
7. [Envio de arquivo do comprovante (opcional)](#7-envio-de-arquivo-do-comprovante-opcional)
8. [Testar localmente com os emuladores](#8-testar-localmente-com-os-emuladores)
9. [Manutenção](#9-manutenção)
10. [Limitações conhecidas desta versão](#10-limitações-conhecidas-desta-versão)

---

## 1. Estrutura do projeto

```
index.html               Página pública da rifa
admin.html               Painel gerencial
css/style.css            Estilos (responsivo)
js/firebase-config.js    >>> Dados do SEU projeto Firebase (editar) <<<
js/firebase.js           Inicialização do Firebase e conexão com emuladores
js/common.js             Utilitários compartilhados (status, formatação…)
js/pix.js                Geração do código Pix "copia e cola" (BR Code)
js/app.js                Seleção, reserva, pagamento e comprovante
js/admin.js              Login, indicadores, tabela e operações administrativas
firestore.rules          Regras de segurança do Firestore  (publicar no Firebase)
storage.rules            Regras de segurança do Storage    (publicar se usar anexos)
firebase.json            Configuração da CLI do Firebase e dos emuladores
tests/regras.test.mjs    Testes automatizados das regras de segurança
dev/                     Servidor local e dados de exemplo para os emuladores
package.json             Somente ferramentas de desenvolvimento (o site não tem build)
```

O site não usa build nem frameworks: HTML, CSS e JavaScript (módulos ES) carregando o SDK do Firebase direto do CDN oficial (`gstatic.com`).

## 2. Como funciona

### Coleções no Firestore

| Coleção | Conteúdo | Quem lê | Quem grava |
|---|---|---|---|
| `config/rifa` | título, descrição, valor, faixa de números, prazo, dados Pix | todos | administradores |
| `numeros/{n}` | **apenas** `status`, `reservaId`, `reservadoEm` — sem dados pessoais. Documento inexistente = número disponível | todos | participante (reservar/enviar comprovante) e administradores, conforme as regras |
| `reservas/{id}` | número, nome, telefone, valor, comprovante, status, carimbos | o próprio participante e administradores | participante (criar/enviar comprovante) e administradores (status) |
| `historico/{id}` | cada ação administrativa: ação, status anterior/novo, e-mail e uid do operador, data/hora, observação | administradores | administradores (somente inclusão; não pode ser alterado nem apagado) |
| `admins/{uid}` | lista de administradores | o próprio usuário | **somente pelo console do Firebase** |

### Participantes

Ao abrir a página, o participante entra automaticamente com **login anônimo** do Firebase. Isso permite que ele veja suas próprias reservas (seção "Minhas reservas") depois de fechar e reabrir o navegador, sem criar conta — e impede que qualquer outra pessoa leia os dados dele.

### Estados

| Número (público) | Significado |
|---|---|
| 🟩 Disponível (`livre`) | pode ser selecionado |
| 🟧 Aguardando pagamento (`reservado`) | reservado, dentro do prazo |
| 🟦 Pagamento em análise | comprovante informado, aguardando conferência |
| ⬜ Pago / confirmado (`✔ pago`) | validado pela equipe |

Cada cartão mostra a cor **e** um texto, para não depender só das cores.

A reserva (dados privados) pode ainda ficar como **Pagamento não identificado**, **Cancelada** ou **Expirada / liberada**.

### Garantias aplicadas pelo banco (não pelo navegador)

- **Reserva exclusiva e atômica:** reserva e número são gravados juntos em uma transação. O participante só pode *criar* o documento do número, nunca sobrescrevê-lo; se duas pessoas tentarem ao mesmo tempo, apenas uma gravação é aceita.
- **Prazo:** passado o prazo configurado (padrão 30 min) **sem comprovante**, o número volta a aparecer como disponível e pode ser reservado por outra pessoa — o servidor confere o horário (não o relógio do aparelho). Números com comprovante enviado (**em análise**) ou pagos **nunca** são liberados automaticamente.
- **Falhas de conexão:** se a conexão cair durante a reserva, uma nova tentativa reutiliza o mesmo identificador; se a primeira tiver sido gravada, ela é reconhecida e nada é duplicado.
- **O participante não altera status de pagamento:** ele só pode mudar a própria reserva de "aguardando"/"não identificado" para "em análise", informando o comprovante.
- **Ações administrativas** exigem usuário autenticado (não anônimo) listado em `admins`, e a alteração só é aceita se vier acompanhada de um registro em `historico` com o e-mail do operador e o horário do servidor.

Os testes automatizados em [`tests/regras.test.mjs`](tests/regras.test.mjs) verificam cada uma dessas garantias.

## 3. Configurar o Firebase

> Plano gratuito (Spark) é suficiente, exceto para anexar arquivos de comprovante (ver seção 7).

1. **Crie o projeto** em <https://console.firebase.google.com> → *Adicionar projeto* (o Google Analytics é opcional).
2. **Cadastre um app da Web:** *Visão geral do projeto* → ícone `</>` → dê um nome (ex.: "Rifa Online"). Não precisa marcar o Firebase Hosting. Copie o objeto `firebaseConfig` exibido.
3. **Cole a configuração** em [`js/firebase-config.js`](js/firebase-config.js), substituindo os valores `demo-…`.
   Esses valores não são secretos; a proteção vem das regras de segurança.
4. **Ative a autenticação:** *Criação → Authentication → Começar → Método de login* e ative:
   - **E-mail/senha** (para a equipe);
   - **Anônimo** (para os participantes).
5. **Autorize o domínio do site:** *Authentication → Configurações → Domínios autorizados* → *Adicionar domínio* → `SEU-USUARIO.github.io`.
6. **Crie o banco:** *Criação → Firestore Database → Criar banco de dados* → escolha a região (ex.: `southamerica-east1`, São Paulo) → **modo de produção**.
7. **Publique as regras de segurança** (escolha uma opção):
   - **Pelo console:** *Firestore Database → Regras* → apague o conteúdo, cole todo o arquivo [`firestore.rules`](firestore.rules) → *Publicar*.
   - **Pela CLI** (na pasta do projeto, com Node.js instalado):
     ```bash
     npm install
     npx firebase login
     npx firebase use --add
     npm run deploy:regras
     ```
     (se não for usar anexos, rode `npx firebase deploy --only firestore:rules`.)
8. **Crie os usuários da equipe:** *Authentication → Usuários → Adicionar usuário* (e-mail e senha). Copie o **UID** de cada um.
9. **Dê permissão de administrador:** *Firestore Database → Dados → Iniciar coleção* → ID da coleção `admins` → ID do documento = **UID do usuário** → adicione o campo `email` (string) com o e-mail dele → *Salvar*. Repita para cada operador.

   > Somente quem estiver na coleção `admins` acessa o painel. Para remover um acesso, apague o documento correspondente (e, se quiser, desative o usuário em Authentication).

**Recomendado:** em <https://console.cloud.google.com/apis/credentials>, edite a chave de API do projeto e restrinja os *referenciadores HTTP* a `https://SEU-USUARIO.github.io/*` (e `http://localhost:5500/*` para testes).

## 4. Publicar no GitHub Pages

1. Crie um repositório no GitHub (ex.: `rifa-online`) — pode ser público; nenhum dado sensível fica no código.
2. Envie os arquivos desta pasta para o branch `main`:
   ```bash
   git init
   git add .
   git commit -m "Rifa Online"
   git branch -M main
   git remote add origin https://github.com/SEU-USUARIO/rifa-online.git
   git push -u origin main
   ```
   (`node_modules/` já está no `.gitignore`.)
3. No GitHub: *Settings → Pages → Build and deployment* → *Source: Deploy from a branch* → *Branch: `main`* / pasta `/ (root)` → *Save*.
4. Em 1–2 minutos o site estará em `https://SEU-USUARIO.github.io/rifa-online/`. O painel fica em `…/rifa-online/admin.html` (também acessível pelo link discreto "Painel gerencial" no rodapé).
5. Confirme que `SEU-USUARIO.github.io` está nos domínios autorizados (passo 3.5).

Para atualizar o site depois, basta fazer *commit* e *push* no `main`.

> Se o site publicado mostrar "O sistema ainda não foi conectado ao Firebase", o arquivo `js/firebase-config.js` ainda está com os valores `demo-…`.

## 5. Primeiro acesso e configuração da rifa

1. Abra `admin.html`, entre com um usuário administrador.
2. Na seção **Configuração da rifa** (abre automaticamente na primeira vez), preencha:
   - **Título** e **descrição**;
   - **Valor de cada número** (ex.: `10,00`);
   - **Prazo da reserva** em minutos (padrão 30);
   - **Primeiro e último número** (padrão 0 a 100);
   - **Chave Pix**. Para chave de telefone use o formato `+5511912345678`;
   - **Nome e cidade do recebedor**: com eles o sistema gera automaticamente o **Pix Copia e Cola com o valor** e o **QR Code**. Sem eles, só a chave é exibida;
   - opcionalmente, um **Pix Copia e Cola fixo** gerado pelo seu banco, ou a **URL de uma imagem de QR Code** (substituem os gerados);
   - opcionalmente, um **contato/WhatsApp** da organização exibido aos participantes.
3. Clique em **Salvar configuração**. A grade aparece imediatamente na página pública.

> Alterar o valor afeta apenas reservas novas: cada reserva guarda o valor esperado no momento em que foi feita.

## 6. Uso no dia a dia (equipe operacional)

- **Indicadores** no topo: total de números, disponíveis, aguardando pagamento, em análise, confirmados e **valor total confirmado** (somente pagamentos aprovados pela equipe).
- **Tabela de reservas** com filtros por número, nome, telefone e status (padrão: reservas ativas). O telefone abre o WhatsApp.
- Tudo é atualizado em tempo real quando outro operador ou participante faz alterações.

| Ação | Quando aparece | Efeito |
|---|---|---|
| **Confirmar pagamento** | aguardando, em análise ou não identificado | reserva e número ficam como **pago** |
| **Manter em análise** | reserva ativa | registra que o pagamento segue em conferência |
| **Não identificado** | aguardando, em análise ou pago | o participante vê o aviso e pode reenviar o comprovante; o prazo é reiniciado |
| **Cancelar reserva** | qualquer reserva ativa | encerra a reserva e libera o número |
| **Liberar número** | aguardando com prazo vencido, ou não identificado | encerra como expirada e libera o número |
| **Detalhes** | sempre | todos os dados, link do arquivo (se houver) e histórico completo |

- Toda ação pede **confirmação**, aceita uma **observação** e grava no histórico data/hora (do servidor), e-mail e UID do operador.
- O botão **Liberar reservas expiradas (N)** aparece quando há reservas vencidas sem comprovante; ele encerra todas de uma vez, conferindo o estado de cada uma no momento da liberação.
- Se dois operadores agirem ao mesmo tempo sobre a mesma reserva, a segunda ação é recusada com o aviso de que os dados mudaram.

**Como conferir:** compare o valor, o identificador/código informado e o horário com o extrato do Pix no aplicativo do banco antes de confirmar. A aplicação **não** tem integração bancária.

## 7. Envio de arquivo do comprovante (opcional)

Por padrão o participante informa apenas o identificador e a referência da transação. Para permitir anexar **imagem ou PDF** (até 5 MB):

1. Ative o **Cloud Storage** no console (*Criação → Storage*). Em projetos novos isso exige o plano **Blaze** (pago conforme uso; volumes de uma rifa costumam ficar dentro da cota gratuita, mas é necessário cadastrar cobrança).
2. Publique [`storage.rules`](storage.rules) (*Storage → Regras*, ou `npm run deploy:regras`). As regras permitem que o participante apenas **envie** arquivos para a própria reserva; somente administradores podem **ler**.
3. No painel, marque **Permitir anexar imagem/PDF do comprovante** e salve.

Os arquivos ficam no Storage (não no Firestore); a reserva guarda só o caminho. No painel, use *Detalhes → Abrir arquivo*.

## 8. Testar localmente com os emuladores

Requisitos: **Node.js 18+** e **Java 11+** (exigido pelos emuladores do Firestore/Storage).

```bash
npm install
```

**Testes automatizados das regras de segurança** (reserva concorrente, permissões, expiração, histórico, Storage):

```bash
npm test
```

**Usar o site com os emuladores** (dados fictícios, nada vai para a nuvem). Enquanto `js/firebase-config.js` tiver `projectId` começando com `demo-`, o site acessado por `localhost` conecta-se aos emuladores automaticamente.

Em três terminais:

```bash
npm run emuladores
```

```bash
npm run seed
```

```bash
npm run servidor
```

Abra <http://localhost:5500> (rifa) e <http://localhost:5500/admin.html> (painel). O comando `seed` cria um administrador local — as credenciais de teste estão no topo de [`dev/seed-emulador.mjs`](dev/seed-emulador.mjs) — e uma configuração de exemplo. A interface dos emuladores fica em <http://localhost:4000>.

Para testar dois aparelhos, abra a rifa em uma janela normal e em uma janela anônima (cada uma é um participante diferente).

## 9. Manutenção

- **Nova rifa / zerar:** no console do Firestore, exporte (se quiser guardar) e apague as coleções `numeros`, `reservas` e `historico`; depois ajuste a configuração no painel. (O painel não apaga dados de propósito.)
- **Backup:** *Firestore → Importar/Exportar* (exige plano Blaze) ou exporte manualmente pelo console.
- **Correções excepcionais:** o console do Firebase ignora as regras, então permite corrigir qualquer documento manualmente. Mantenha os documentos de `numeros` e `reservas` coerentes (o `reservaId` do número deve apontar para a reserva ativa).
- **Atualizar o SDK do Firebase:** troque a versão `10.14.1` nas URLs de [`js/firebase.js`](js/firebase.js).
- **Alterou `firestore.rules`?** Rode `npm test` e publique as regras novamente.
- **Privacidade (LGPD):** nome e telefone ficam visíveis apenas para o próprio participante e para administradores. Ao final da rifa, apague os dados que não precisar mais guardar.

## 10. Limitações conhecidas desta versão

- Não há confirmação bancária automática, sorteio, notificações nem múltiplas rifas (fora do escopo do MVP).
- Uma pessoa mal-intencionada pode reservar vários números sem pagar; eles voltam a ficar disponíveis ao fim do prazo, e a equipe pode cancelá-los antes. Para endurecer, ative o **Firebase App Check** com reCAPTCHA.
- O participante acompanha as reservas no mesmo navegador/aparelho em que reservou (login anônimo). Se limpar os dados do navegador, a reserva continua válida no sistema, mas ele deve falar com a organização para acompanhar.
- A contagem regressiva usa o relógio do aparelho; a decisão final sobre o prazo é sempre do servidor.
