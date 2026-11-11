---
name: real-sfx
description: "Coloca som real no frame exato do vídeo (som de verdade, nunca sintetizado) — use quando o usuário pedir som para o vídeo, sonorização, efeitos no vídeo, 'coloca som', 'sonoriza', 'deixa o vídeo com som', ou quando um vídeo do HyperFrames ou uma gravação de tela precisar de sons nos momentos certos. Gatilhos: real-sfx, som no vídeo, sonorizar, colocar som, efeito no vídeo, som no frame, som de transição, som de clique, som de explosão, coloca som no vídeo."
argument-hint: "[vídeo] [lista de momentos, se houver]"
license: MIT
---

# /real-sfx

Coloque som REAL no frame exato do vídeo: cada som é uma gravação de verdade, colocada no momento certo, mantendo a música e a voz do vídeo.

## A regra de ouro

O som nunca é sintetizado. Cada som que entra no vídeo é uma gravação real (da pasta de sons do usuário ou do Openverse). Se não houver um som que caiba no momento, o momento fica em silêncio e vai para o relatório — nunca invente um som.

## O que você não tem

- **Você não ouve.** O som se lê em números, palavras e imagens: duração, nível, espectro, o que se move no frame e quando. Diga o que foi conferido por medição e o que o usuário deve ouvir com o ouvido dele.
- **Não há biblioteca de sons embutida.** Os sons vêm de dois lugares: a pasta de sons do usuário (quando ele tiver uma) e o Openverse (veja a skill `openverse`). A skill original traz um pacote pequeno de sons de interface com licença aberta (uisfx, 78 sons), que não vem embutido aqui — sons de interface (cliques, pops) se acham no Openverse.
- **Não há scripts próprios.** A versão original desta skill usava scripts próprios para cada passo; aqui o agente faz cada passo com o FFmpeg direto e com as ferramentas que já conhece.

## De onde vêm os sons

1. **A pasta de sons do usuário** (quando ele tiver uma — use a que ele já indicou).
2. **Openverse** (skill `openverse`): busque por tipo (`whoosh`, `click`, `rain`, `applause`), com `license_type=commercial` para uso comercial e `license=cc0` para domínio público. Baixe o arquivo e guarde na pasta de sons do projeto (ex.: `sfx/`).
3. **Sem som que caiba**: o momento fica em silêncio e entra no relatório com o motivo.

Cada som usado entra no relatório com título, quem gravou, licença e a linha de atribuição (quando a licença pedir).

## 1. Achar os momentos

O momento é o instante exato em que algo pede som. Ache os momentos por uma destas fontes:

1. **A lista de momentos do projeto** (ex.: `cues.json`, `docs/cues.json`): use-a direto. Cada item tem tempo e tipo: `[{"t":0.80,"type":"pop"},{"t":2.10,"type":"whoosh"}]`.
2. **A timeline do HyperFrames**: leia os atributos `data-start` da composição — cada `data-start` é o tempo em que um elemento entra, e é ali que o som cai.
3. **Vídeo puro, sem lista**: extraia frames com o FFmpeg e anote o que se move e quando (corte, entrada, impacto, texto que aparece). Escreva a sua própria lista de momentos no mesmo formato.
4. **Sob música**: coloque o som no corte ou na batida, nunca fora dela.

Tipos de momento (use os nomes da lista): `pop`, `whoosh`, `hit`, `riser`, `chime`, `click`, `typing`, `cut`, `burst`, `onset`, `settle`.

Regras para a lista:

- Um momento por evento visível; não coloque som em cada corte (só nos cortes pesados, no máximo um terço deles).
- Eventos com menos de 25 ms de distância viram um só momento.
- Digitação: 8 a 14 teclas por segundo, um som por tecla, um só teclado para o texto inteiro.
- Um objeto físico só tem um som (um objeto, uma família de gravações).

## 2. Escolher os sons

- Escolha pelo que se move e pelo que ele atinge: um botão pede um clique, uma transição pede um whoosh, um impacto pede um hit.
- Busque no Openverse pelo tipo e leia título, tags e duração — não confie só no nome do arquivo.
- Não repita o mesmo arquivo várias vezes seguidas (quatro takes de uma gravação contam como um só som).
- A linguagem da interface é uma só: os botões soam como uma família.
- Se nenhum som couber, o momento fica em silêncio e vai para o relatório.

## 3. Montar a mixagem com o FFmpeg

Monte a trilha de efeitos com o FFmpeg direto. Cada som entra no tempo exato com `adelay` e tudo se mistura com `amix`:

```
ffmpeg -i video.mp4 -i sfx/pop.mp3 -i sfx/whoosh.mp3 -filter_complex \
  "[1:a]adelay=800|800[pop];[2:a]adelay=2100|2100[whoosh];[pop][whoosh]amix=inputs=2:normalize=0[sfx]" \
  -map 0:v -map "[sfx]" -c:v copy -c:a aac resultado_sfx.mp4
```

- O tempo do `adelay` é em milissegundos e é o tempo do momento (0.80 s = 800 ms).
- O som chega no frame exato: o ataque do som cai no tempo do momento (o som pode começar um pouco antes se o ataque dele for lento — o pico é o que marca).
- **Níveis por tipo** (pico alvo, dBFS): hit −4, whoosh −9, riser −12, clique/interface/pop −14, ambiente −24. Sons pequenos ficam entre 0 e −4 dB do nível do tipo — não mais baixo que isso.
- **Abaixar sob voz e música**: os efeitos ficam 6 a 10 dB mais baixos quando há voz por cima, sem sumir; sob música, o que importa vai na batida e o som tonal vai na nota.
- **Mono**: confira que nenhum som some quando a mixagem vira mono (um som que perde mais de 6 dB em mono é um problema — use a versão mono dele).
- **Sonoridade**: sem som próprio no vídeo, leve o resultado a −14 LUFS (filtro `loudnorm`); com som próprio, não mexa no balanço do autor.
- **Não duplique**: se o vídeo já tem um som sintetizado no render, troque-o pelo som real — não coloque o som real por cima dele.

Entregue dois arquivos:

- `*_sfx.mp4`: o vídeo com a trilha nova.
- `*_sfx_track.wav`: a trilha de efeitos separada (só os efeitos, sem a música e sem a voz do vídeo).

## 4. Conferir antes de mostrar

Antes de mostrar o resultado, confira por medição:

1. **Cada som está na trilha, no lugar certo**: confira com `ffprobe`/`ffmpeg` (volumedetect) que cada som aparece no tempo da lista.
2. **Níveis**: o pico de cada tipo está no alvo; nenhum som some sob a voz.
3. **Mono**: a soma em mono não apaga nenhum som.
4. **Sonoridade**: o resultado está em −14 LUFS (quando não há som próprio) ou no balanço do autor (quando há).
5. **A lista de escuta**: anote até cinco momentos em que os números são menos certos (o gancho, o mais alto, os que podem estar fora de sincronia, os que podem estar abafados) — com timecode e uma pergunta para o ouvido. Não diga que "soa bem" sem o usuário ouvir.

Se um eixo ficar abaixo do esperado por causa da métrica e não do som (ex.: vídeo curto, quadros parados, silêncio que é certo), explique com timecodes — não cure inserindo um som.

## 5. Entregar

Entregue:

- O caminho do MP4 e do WAV separado.
- Quantos sons de cada fonte (pasta do usuário, Openverse).
- O que ficou em silêncio e por quê.
- A sonoridade final.
- A lista de escuta (cinco momentos com timecode e pergunta).

Anote os sons que o usuário disser que não gostou, para não usar de novo. Ofereça apagar os arquivos de trabalho (rounds, intermediários) quando pesarem.

## Regras de gosto

- **Gancho**: um som nos primeiros 2 s (música ou voz também valem como gancho); depois, algo novo a cada 2 a 4 s. Vazio maior que 4 a 5 s sem motivo (quadro parado, som próprio) é um buraco.
- **Um grande momento é camadas** (hit + pop + poeira), não um arquivo alto; no máximo 3 camadas.
- **Não é um hit em cada corte**: só nos cortes pesados (no máximo um terço).
- **A interface fala uma língua só**: os botões soam como uma família.
- **Sob voz**: efeitos 6 a 10 dB mais baixos, mas audíveis; sob música, não crie o seu próprio pulso — ponha o que importa na batida.
- **Um filme só de efeitos é mais denso** que um com música: por volta de 7 a 15 gestos por 10 s; um filme calmo tem o seu próprio silêncio.

## Se o FFmpeg não estiver disponível

Não trave o turno e não peça instalação. Faça tudo o que dá sem ele:

1. Ache os momentos (lista do projeto, `data-start` do HyperFrames ou frames do vídeo).
2. Ache os sons no Openverse e baixe-os para a pasta `sfx/` do projeto.
3. Escreva a lista de momentos final (o arquivo de cues) e os comandos exatos do FFmpeg para rodar quando houver FFmpeg — cada som com o seu tempo, nível e papel.
4. Entregue a lista, os sons e os comandos, e diga que a mixagem fica pronta assim que o FFmpeg estiver disponível.

O usuário leigo não instala nada: o trabalho chega pronto para mixar, e a mixagem acontece quando houver FFmpeg no computador.

## Nota

No Mac, o README original pedia o `ffmpeg-full` do Homebrew porque o FFmpeg comum pode não ter dois filtros que o fluxo original usava. Este fluxo usa só filtros do FFmpeg comum; se algum filtro faltar, use o equivalente disponível.
