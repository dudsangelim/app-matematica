# App Matemática: Ilha dos Números

Jogo educativo em 3D para praticar a matemática do 1º ano do ensino fundamental (BNCC/MEC), no estilo dos jogos de blocos que as crianças adoram.

A criança controla um boneco de blocos numa **cidade central**. Os **portais** levam a 8 mundos, um para cada capítulo do caderno:

| Mundo | Capítulo | Jogos |
|---|---|---|
| Obby das Contas | Adição e subtração | Obby sobre o mar, Estoura-Balão (tiro) |
| Corrida dos Números | A ordem dos números | Corrida dos cubos, Chão de Lava |
| Vila das Posições | Vocabulário fundamental | Circular, pular e pintar (inclui direita/esquerda e na frente/atrás); O Mestre Mandou |
| Fazenda do 10 | Números até 10 | Pintar, levar ao cesto, padrões, gráfico de colunas, "certeza, talvez, impossível"; Ajude os Amigos (dividir) |
| Parque das Formas | Figuras geométricas | Caça às Formas, Tiro às Formas |
| Mercadinho | Nosso dinheiro | Pagar, troco, caixa; Atenda os Clientes |
| Torre do 100 | Números até 39 e até 100 | Dezenas e unidades, quadro do 100, Chão de Lava |
| Oficina das Medidas | Grandezas e medidas | Lápis, prédios, copos, balança; Construa a Escada |

## Recursos

- Ações com o boneco: **pular em cima**, **correr em volta para circular**, **pegar tinta e pintar**, **carregar objetos**, **atirar**, **sobreviver**, **construir** e **ajudar amigos**.
- Os níveis 1 a 3 se ajustam sozinhos aos acertos da criança.
- Cada resposta é registrada por **habilidade** (por exemplo, "calcular o troco"). O que a criança erra **volta nas rodadas seguintes**, até ela acertar duas vezes de primeira.
- **Estrelas e moedas de bônus acompanham os acertos de primeira**: 3 estrelas com tudo certo (rodadas de 6 ou mais perguntas aceitam um erro), 2 com 60% e 1 com 30%.
- Depois de dois erros, o jogo **mostra a resposta pronta** (inclusive no cesto e na divisão entre amigos). Certo e errado têm sempre um **✓ ou ✗**, não só a cor.
- No Obby, até 20, a placa mostra a conta também em **bolinhas** para contar.
- O **painel de instruções** de cada jogo pode ser encolhido (toque nele ou no ▴) para ver o cenário inteiro; encolhido, ele abre sozinho por alguns segundos a cada pergunta nova.
- No Chão de Lava, o botão **"Já sei!"** dispensa a espera do cronômetro, e encostar na lava antes da hora não tira coração.
- **Narração** das perguntas em português, com mais tempo para ler antes do cronômetro começar.
- **Música de rock leve** gerada no próprio jogo, uma para cada mundo.
- **Animações** do boneco: queimado na lava, frustrado, comemorando, dança da vitória, molhado e tonto.
- **Loja** com conta de troco na hora de comprar: chapéus, roupas, bichinhos e poderes.
- **Troféus**: medalhas de bronze e prata, uma taça de ouro por estação e a Taça dos Campeões, todos expostos na Sala de Troféus.
- **Área dos pais**, protegida por uma conta: desempenho por estação, **semana a semana** e **por habilidade**, aviso de pausa opcional e **cópia de segurança** do progresso (salvar e restaurar um arquivo).
- **Visual**: céu em degradê com sol, mar com ondas, sombras nítidas, flores, arbustos e pedras, e cabelo no boneco (aba Cabelo da Loja). O jogo mede a velocidade do aparelho e **reduz o visual sozinho** se ficar lento; no Menu ☰ dá para escolher **Visual leve**.
- **Vários jogadores** no mesmo aparelho (Menu ☰ → Jogadores), cada um com seu progresso.
- Opção de **LETRAS MAIÚSCULAS** em todo o jogo (Menu ☰), para quem ainda lê em letra bastão.

## Jogar agora

👉 **https://dudsangelim.github.io/app-matematica/**

### Instalar no tablet ou celular (vira um app, funciona sem internet)

- **Android (Chrome):** abra o link, toque nos 3 pontinhos ⋮ e depois em **Instalar app** (ou **Adicionar à tela inicial**).
- **iPad / iPhone (Safari):** abra o link, toque em **Compartilhar** ⬆️ e depois em **Adicionar à Tela de Início**.

Depois do primeiro acesso com internet, o jogo abre pelo ícone mesmo offline.

## Como jogar

O jogo inteiro está em `index.html`. O [three.js](https://threejs.org/) (`vendor/`) e as fontes (`fonts/`) ficam neste mesmo site: o jogo não carrega nada de outros endereços, e o `sw.js` guarda tudo para uso offline. Na primeira vez, o jogo pergunta o nome do jogador.

- Para andar, arraste no lado esquerdo da tela. Para girar a câmera, arraste no lado direito ou use os botões ⟲ ⟳. Para pular, toque em ⬆.
- No computador: WASD ou setas para andar, Espaço para pular, E para falar ou confirmar, F para atirar e Q ou R para girar a câmera.

O progresso fica salvo no navegador do próprio aparelho (`localStorage`). Nada é enviado para fora. Para não perder o progresso ao limpar o navegador ou trocar de aparelho, use a cópia de segurança da Área dos pais.

## Testes

```bash
npm install
```

```bash
npx playwright install chromium
```

```bash
npm test
```

Os testes (`tests/smoke.test.js`) abrem o jogo de verdade num navegador sem tela e conferem: os 16 modos nos 3 níveis, milhares de perguntas geradas (todas com resposta válida), pontuação, layout em celular, uso de memória, jogadores, cópia de segurança e funcionamento offline. Eles rodam sozinhos no GitHub a cada envio (`.github/workflows/test.yml`).

Ao mudar um arquivo listado em `CORE` no `sw.js` (por exemplo, `vendor/three.min.js`), aumente o número em `CACHE` para os aparelhos buscarem a versão nova.
