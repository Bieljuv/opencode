# manostech-tools — Node + FFmpeg embutidos (só na máquina de build)

O vídeo local do Editor (skill `hyperframes`, comando `/video`) precisa de
Node 22+ (para rodar a CLI do HyperFrames) e de FFmpeg + ffprobe (para
renderizar e mixar o som) no computador do cliente. O instalador leva os três
binários junto, nesta pasta, um subdiretório por plataforma:

```
manostech-tools/
  win32-x64/
    node.exe        (Node 22 LTS, nodejs.org)
    ffmpeg.exe      (Gyan.dev, build essentials)
    ffprobe.exe     (mesmo build)
```

## Por que não estão no git

Os três juntos passam de 200 MB (só o `ffmpeg.exe` tem ~105 MB) — acima do
limite de 100 MB por arquivo do GitHub. Mesmo precedente do outro desktop
(Forge, `apps/desktop/vendor/`): binário grande vai só na máquina de build,
ignorado no `.gitignore`, e é restaurado do zip-fonte. **Nunca commite
binário aqui.**

## Restaurar

Na máquina de build (ou numa dev), antes do pack:

```
bun run script/fetch-manostech-tools.ts
```

O script baixa os zips oficiais, extrai só os binários necessários para
`win32-x64/` e confere que os três existem e não estão vazios. As versões
fixadas vivem no topo do script. O workflow de release (`release-windows.yml`)
roda o script antes do pack; sem ele, o instalador sai sem as ferramentas e
o app avisa no lugar de renderizar (o `afterPack` do
`electron-builder.config.ts` só alerta quando nada foi staged, e falha
quando um diretório staged está incompleto).

## Fontes oficiais

- Node: https://nodejs.org/dist/v22.21.0/node-v22.21.0-win-x64.zip
- FFmpeg: https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
  (o zip do Gyan traz `ffmpeg.exe`, `ffprobe.exe` e `ffplay.exe`; só os dois
  primeiros vão para o instalador)

## Como o app usa

Na inicialização, o processo principal resolve esta pasta
(`src/main/service/manostech-tools.ts`) e a coloca na frente do PATH do
servidor local, junto com `MANOSTECH_FFMPEG`, `MANOSTECH_FFPROBE` e
`MANOSTECH_NODE`. O shell do agente encontra `node`, `npx`, `ffmpeg` e
`ffprobe` sem instalar nada. O navegador do renderizador ainda é baixado na
primeira vez (`npx hyperframes browser ensure`, precisa de internet).
