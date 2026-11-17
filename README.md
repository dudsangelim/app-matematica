# App Matemática: Ilha dos Números

Jogo educativo em 3D para praticar a matemática do 1º ano do ensino fundamental (BNCC/MEC), no estilo dos jogos de blocos que as crianças adoram.

A criança controla um boneco de blocos numa **cidade central**. Os **portais** levam a 8 mundos, um para cada capítulo do caderno:

| Mundo | Capítulo | Jogos |
|---|---|---|
| Obby das Contas | Adição e subtração | Obby sobre o mar, Estoura-Balão (tiro) |
| Corrida dos Números | A ordem dos números | Corrida dos cubos, Chão de Lava |
| Vila das Posições | Vocabulário fundamental | Circular, pular e pintar; O Mestre Mandou |
| Fazenda do 10 | Números até 10 | Pintar, levar ao cesto; Ajude os Amigos (dividir) |
| Parque das Formas | Figuras geométricas | Caça às Formas, Tiro às Formas |
| Mercadinho | Nosso dinheiro | Pagar, troco, caixa; Atenda os Clientes |
| Torre do 100 | Números até 39 e até 100 | Dezenas e unidades, quadro do 100, Chão de Lava |
| Oficina das Medidas | Grandezas e medidas | Lápis, prédios, copos, balança; Construa a Escada |

## Recursos

- Ações com o boneco: **pular em cima**, **correr em volta para circular**, **pegar tinta e pintar**, **carregar objetos**, **atirar**, **sobreviver**, **construir** e **ajudar amigos**.
- Os níveis 1 a 3 se ajustam sozinhos aos acertos da criança.
- **Narração** das perguntas em português, com mais tempo para ler antes do cronômetro começar.
- **Música de rock leve** gerada no próprio jogo, uma para cada mundo.
- **Animações** do boneco: queimado na lava, frustrado, comemorando, dança da vitória, molhado e tonto.
- **Loja** com conta de troco na hora de comprar: chapéus, roupas, bichinhos e poderes.
- **Troféus**: medalhas de bronze e prata, uma taça de ouro por estação e a Taça dos Campeões, todos expostos na Sala de Troféus.
- **Área dos pais**, protegida por uma conta, com o desempenho por capítulo.

## Jogar agora

👉 **https://dudsangelim.github.io/app-matematica/**

### Instalar no tablet ou celular (vira um app, funciona sem internet)

- **Android (Chrome):** abra o link, toque nos 3 pontinhos ⋮ e depois em **Instalar app** (ou **Adicionar à tela inicial**).
- **iPad / iPhone (Safari):** abra o link, toque em **Compartilhar** ⬆️ e depois em **Adicionar à Tela de Início**.

Depois do primeiro acesso com internet, o jogo abre pelo ícone mesmo offline.

## Como jogar

O jogo é um único arquivo, `index.html`. Ele carrega o [three.js](https://threejs.org/) pela internet no primeiro acesso, e o `sw.js` guarda tudo para uso offline. Na primeira vez, o jogo pergunta o nome do jogador.

- Para andar, arraste no lado esquerdo da tela. Para girar a câmera, arraste no lado direito ou use os botões ⟲ ⟳. Para pular, toque em ⬆.
- No computador: WASD ou setas para andar, Espaço para pular, E para falar, F para atirar e Q ou R para girar a câmera.

O progresso fica salvo no navegador do próprio aparelho (`localStorage`).
