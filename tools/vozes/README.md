# Vozes dos personagens

Cada personagem fala com uma voz própria, gravada aqui mesmo no computador com o [Kokoro](https://github.com/hexgrad/kokoro) (modelo de voz aberto, licença Apache 2.0). Nada é enviado para fora.

O resultado fica em `vozes/`: um MP3 por personagem com todas as falas dele, uma depois da outra, e `vozes/vozes.json` dizendo onde começa cada fala. O jogo guarda o arquivo comprimido e só abre a fala da vez.

## O que é gravado e o que não é

- **Gravado**: o que cada personagem diz quando aparece falando, com o nome na tela: a apresentação de cada anfitrião e o aviso do descanso do ouro, as falas curtas dos amigos e do lojista, e o Mestre Mandou inteiro (as ordens montadas por partes, "O mestre mandou:", "primeiro pule 3 vezes,", "depois toque o sino"..., e os acertos e correções do Mestre).
- **Não gravado**: tudo o que a narradora fala dentro dos jogos (perguntas, contas, dicas, acertos e explicações), que muda a cada vez. Ela usa a voz feminina mais natural do próprio aparelho. Uma fala nunca mistura gravação e voz do aparelho: se ela não estiver gravada inteira, é dita inteira pela voz do aparelho.

A lista das falas sai do próprio jogo (`voiceScript` em `index.html`). Assim o texto na tela e o áudio nunca ficam diferentes: se uma fala mudar no jogo e não for gravada de novo, ela é dita com a voz do aparelho até a próxima gravação. O teste `recorded voices` (em `npm test`) avisa quando isso acontece.

## Como cada voz é feita

O Kokoro tem três vozes brasileiras (`pf_dora`, `pm_alex`, `pm_santa`). Para ter uma voz por personagem, o gerador separa uma voz do Kokoro em duas partes: o **timbre** (quem fala) e o **ritmo e a melodia** da fala. Cada personagem pega o timbre de uma voz diferente com o ritmo e a melodia de uma voz brasileira, e ganha ainda um tom e uma velocidade próprios. As crianças (Ana, Pedro e Léo) têm a voz "menor" (formantes mais altos). As receitas estão em `CAST`, no começo de `gerar.py`.

## Gravar de novo

Precisa de Python 3.10 ou mais novo e do `ffmpeg` (com `librubberband` e `libmp3lame`).

```bash
pip install -r tools/vozes/requirements.txt
```

```bash
node tools/vozes/exportar.js
```

```bash
python tools/vozes/gerar.py
```

Na primeira vez ele baixa os modelos (uns 350 MB) para `tools/vozes/.modelos`. As falas que não mudaram vêm de `tools/vozes/.cache`, então gravar de novo depois de mudar uma fala é rápido.

Para conferir a pronúncia, `python tools/vozes/gerar.py --conferir` passa cada fala por um reconhecedor de fala (Whisper) dentro de uma frase de contexto e lista as que ele ouviu diferente do texto.

Depois de gravar, aumente o número em `CACHE` no `sw.js` para os aparelhos buscarem as vozes novas.
