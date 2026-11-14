# impeccable — motor de qualidade visual embutido (só na máquina de build)

O `/impeccable` do Editor (skill `impeccable`) precisa do motor
`impeccable.exe` no computador do cliente: ele roda o detector de 62 regras,
lê os arquivos de referência da skill e o índice de fontes. O instalador
leva o motor junto com a skill, nesta pasta, um subdiretório por plataforma:

```
impeccable/
  win32-x64/
    impeccable.exe               (motor 0.1.24, release do pbakaus/impeccable)
    SKILL.md                     (cópia da skill portada, do plugin)
    reference/                   (mesma cópia: 45 arquivos + degraded/)
    scripts/data/font-index.json (índice de fontes do upstream)
```

## Por que não está no git

O binário tem ~21,5 MB — abaixo do limite de 100 MB por arquivo do GitHub,
mas o precedente é o fetch em tempo de build (`manostech-tools`): binário
grande vai só na máquina de build, ignorado no `.gitignore`, e é restaurado
da fonte oficial. **Nunca commite binário aqui.**

## Restaurar

Na máquina de build (ou numa dev), antes do pack:

```
bun run script/fetch-impeccable.ts
```

O script baixa o binário do release oficial (versão fixada + sha256),
o índice de fontes do commit fixado do upstream (sha256), copia a SKILL.md
e o `reference/` da skill portada no plugin e confere que os arquivos
existem e não estão vazios. As versões fixadas vivem no topo do script.
O workflow de release (`release-windows.yml`) roda o script antes do pack;
sem ele, o instalador sai sem o motor e a skill avisa que o detector não
está disponível no lugar de checar (o `afterPack` do
`electron-builder.config.ts` só alerta quando nada foi staged, e falha
quando um diretório staged está incompleto).

## O que NÃO vai junto (e por quê)

Os JS do modo ao vivo (`scripts/live-browser*.js`, ~620 KB, e
`scripts/modern-screenshot.umd.js`, ~29 KB) **não** são staged: o motor
já os embute no binário (`include_str!`/`include_bytes!` em
`crates/live/src/browser_assets.rs`, no commit fixado) e serve a cópia
embutida quando os arquivos não estão no disco — a cópia em disco seria
byte-idêntica e só existiria para o motor preferir o disco. O que o
motor lê do disco de verdade é só o `font-index.json`
(`IMPECCABLE_SKILL_DIR/scripts/data/font-index.json`, em
`crates/comp-verbs/src/font_match.rs`) e a skill (`SKILL.md` +
`reference/`, lidas pelo agente). Launcher (`impeccable`/`impeccable.cmd`),
`VERSION` e `command-metadata.json` também não vão: o app chama o
binário direto, sem launcher.

## Fontes oficiais

- Motor: https://github.com/pbakaus/impeccable/releases/download/engine-v0.1.24/impeccable-windows-x64.exe
- Índice de fontes: https://raw.githubusercontent.com/pbakaus/impeccable/1995764b4936f2bfbf4eb719cb37b384a45ceacb/skill/scripts/data/font-index.json
- Skill (fonte da cópia): `packages/plugins/manostech-skills/skills/impeccable/`

## Como o app usa

Na inicialização, o processo principal resolve esta pasta
(`src/main/service/manostech-tools.ts`) e a coloca na frente do PATH do
servidor local, junto com `IMPECCABLE_SKILL_DIR`. O shell do agente
encontra `impeccable` sem instalar nem baixar nada, e o motor encontra a
skill, as referências e o índice de fontes no mesmo diretório.
