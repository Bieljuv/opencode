---
name: hyperframes
description: "Cria vídeos escrevendo HTML: o HyperFrames renderiza a página em MP4, quadro a quadro, sempre igual — vídeo do produto, lançamento, explicativo, legendas e motion graphics com as telas reais do projeto. Use quando pedirem um vídeo, vídeo do produto, vídeo de divulgação, renderizar vídeo, clipe vertical, vídeo explicativo. Gatilhos: hyperframes, fazer vídeo, vídeo do produto, vídeo de divulgação, renderizar vídeo, clipe vertical, vídeo explicativo, vídeo de lançamento."
argument-hint: "[o que o vídeo mostra, ex.: lançamento do app, tour da tela inicial]"
license: Apache-2.0
---

# /video — do roteiro ao MP4 com som

HyperFrames é um framework aberto (Apache-2.0, da HeyGen) de "vídeo como código": a composição é um arquivo HTML com CSS e animações GSAP, e a CLI renderiza em MP4 buscando quadro a quadro num Chrome headless com FFmpeg — mesmo arquivo de entrada, mesmo vídeo de saída, sempre. O vídeo sai do computador do usuário, sem custo por vídeo. Use esta skill quando pedirem um vídeo do produto/projeto.

## O FLUXO ÚNICO — um comando, do roteiro à entrega

"Faz um vídeo" é UM fluxo só, sempre nesta ordem — nunca entregue só uma parte dele:

1. **Escrever** a composição (esta skill).
2. **Conferir** com lint, check e snapshot — e mostrar o preview para aprovar.
3. **Renderizar** o MP4 com a CLI.
4. **Sonorizar**: carregue a skill `real-sfx` e siga ela — ela lê os `data-start` da composição, busca os sons na skill `openverse` e mistura tudo com o FFmpeg. Vídeo com mais de ~15 s sem som é entrega incompleta: tente sonorizar sempre; se nenhum som couber, diga isso no relatório e entregue mudo.
5. **Entregar**: escreva a página `video/assistir.html` (abaixo) e coloque na resposta o link para ela e o link para o MP4. A página abre no painel ao lado do chat e o vídeo toca ali dentro; o link do MP4 abre ou baixa o arquivo.

Narração não faz parte deste fluxo: sem voz gravada pelo usuário, o vídeo sai só com música e efeitos.

## ANTES DE TUDO — O AMBIENTE

O Editor traz as ferramentas junto (Node e FFmpeg embutidos no app, na pasta de ferramentas do instalador, já no PATH do servidor): rode pelos comandos do projeto (com a aprovação do usuário) `node --version` e `ffmpeg -version` — os dois devem responder direto, sem instalar nada. Se o FFmpeg MESMO ASSIM não responder, a instalação do app está incompleta: avise o usuário em uma frase simples (nunca peça pra ele instalar nada por conta própria) e siga com o resto do fluxo — a composição, o check e os snapshots não precisam dele; só o render e a mixagem ficam esperando. Depois: `npx hyperframes doctor --json` pra conferir o ambiente. Na primeira vez, o navegador do renderizador ainda precisa ser baixado: `npx hyperframes browser ensure` (precisa de internet, uma só vez).

## COMEÇAR

Projeto novo de vídeo: `npx hyperframes init video` (pasta `video/` dentro do projeto). Se o assunto é um site, `npx hyperframes capture ENDEREÇO` captura a página como base. A composição raiz é o `index.html`; cenas ficam em `compositions/`, arquivos em `assets/` (caminhos sempre relativos à raiz: `assets/...`).

## O CONTRATO (o check acusa cada violação, com a correção)

1. Todo elemento com tempo tem class "clip", `data-start` e `data-duration` em segundos, e aparece no intervalo [start, start+duration).
2. A duração do vídeo é o `data-duration` da raiz: o que passa é cortado; o que falta segura o último quadro.
3. Cada composição monta UMA linha do tempo pausada (GSAP) e a registra no fim: `window.__timelines["ID-DA-COMPOSICAO"] = tl`.
4. Nada de `Date.now()`, `Math.random()` sem semente, buscas de rede, timers ou repeat infinito: tudo que aparece é função do tempo da linha do tempo.
5. Nunca anime display/visibility de um `.clip` (anime um filho dele) e nunca misture transform de CSS com transform do GSAP no mesmo elemento: anime transform, não left/top/width/height.
6. Nunca dê play/pause nem busque posição em mídia: vídeo com som leva `data-has-audio="true"`, senão muted; música, voz e efeitos são elementos audio separados, cada um com id.
7. Fontes: só as embutidas resolvem pelo nome; qualquer outra entra por @font-face apontando pra arquivo em `assets/fonts/`.
8. Padrão de um vídeo novo: 1920x1080 a 30fps (vertical: 1080x1920). Conteúdo dentro dos 90% centrais da tela; legendas e textos-chave dentro dos 80%.

## REGRAS DA CASA (inegociáveis)

- Mostre coisas REAIS da fonte: as telas do produto são as capturas de verdade do projeto (screenshot_preview e as imagens do projeto), nunca telas regeneradas por IA nem números inventados. Desenhe só o que não tem fonte real.
- Captura de produto aparece INTEIRA e PARADA, sem zoom nem efeito Ken Burns: o movimento é dos elementos ao redor (títulos, destaques, molduras), não da captura.
- Vídeo de divulgação: mire em 60 segundos ou mais, com música e som nas ações visíveis quando o vídeo conta uma história (mais de ~15s); sem narração nem legendas, a menos que peçam.
- Revisão é editar o HTML e renderizar de novo — nunca recomeçar do zero nem gerar outro vídeo por outro caminho.

## O CICLO DE TRABALHO

1. Escreva a composição. Rode `npx hyperframes lint` a cada mudança estrutural.
2. `npx hyperframes check --json`: corrija TODOS os erros (o check inclui layout e contraste, com cor sugerida nas falhas).
3. `npx hyperframes snapshot`: ele salva PNGs dos quadros em `.hyperframes/artifacts/snapshots/` — LEIA os PNGs: é assim que você VÊ o vídeo. Fotografe o meio de cada cena; conteúdo minúsculo sem estilo ou herói faltando é defeito de montagem.
4. `npx hyperframes preview --background`: confira que o endereço responde e entregue o link pro usuário aprovar no preview. Passar no check, sozinho, NÃO é motivo pra renderizar.
5. Render final só com o ok do usuário (ou se ele pediu o arquivo direto): `npx hyperframes render --quality delivery --output video/video-pronto.mp4` (draft enquanto itera, looks no meio do caminho). Confirme o arquivo não-vazio e a duração (`ffprobe`) igual ao `data-duration` da raiz, e olhe quadros decodificados antes de entregar.
6. Sonorize com a skill `real-sfx` (passo 4 do fluxo único): os sons vêm do Openverse pela skill `openverse`; a mistura final é `video/video-pronto_sfx.mp4`. Se a mixagem não sair (por exemplo, sem FFmpeg), entregue o MP4 mudo e diga em uma frase o que ficou faltando — nunca prometa o som para depois sem data.
7. Entregue: escreva `video/assistir.html` com este conteúdo (ajuste só o título) e coloque na resposta o link para ela e para o MP4:

```html
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Vídeo do projeto</title>
<style>body{margin:0;background:#000;display:flex;min-height:100vh;align-items:center;justify-content:center}video{width:100%;max-width:960px}</style>
</head>
<body>
<video src="video-pronto_sfx.mp4" controls autoplay muted playsinline></video>
</body>
</html>
```

Se o vídeo saiu sem som (passo 6 não completou), aponte o `src` para `video-pronto.mp4`. O link da página abre o vídeo no painel ao lado do chat; o link do MP4 abre ou baixa o arquivo.

ATALHOS ÚTEIS: `npx hyperframes docs TEMA` (a documentação oficial, sob demanda); a timeline se edita por comando (`timeline move/trim/split...`) se o usuário pedir ajustes finos; renders em lote com `--batch` a partir de um JSON de variáveis.
