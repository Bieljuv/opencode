---
name: openverse
description: "Acha sons, efeitos e músicas com licença aberta no Openverse (busca de mídia do WordPress) — use quando o usuário pedir um som, um efeito sonoro, uma música ou um ambiente para um vídeo, ou quando faltar um som para colocar no vídeo. Gatilhos: openverse, som para o vídeo, efeito sonoro, achar som, baixar som, som com licença, música de fundo, ambiente sonoro, som de clique, som de whoosh, som de explosão, som de chuva."
argument-hint: "[o que procurar, ex.: whoosh, clique, chuva]"
license: MIT
---

# /openverse

Ache sons, efeitos, músicas e ambientes com licença aberta no Openverse e baixe o arquivo para o projeto.

## O que é o Openverse

O Openverse é a busca de mídia com licença aberta do WordPress. A API de áudio é pública:

- Base: `https://api.openverse.org/v1/audio/`
- Acervo: cerca de 5,2 milhões de áudios (Wikimedia, Jamendo, Freesound e outros).
- **Sem chave de API e sem cadastro**: o agente chama a API direto.
- Cada arquivo carrega a própria licença — leia a licença de cada arquivo antes de usar.

## Como buscar

Chame a API com curl:

```
curl "https://api.openverse.org/v1/audio/?q=<palavras>&license_type=commercial&page_size=10"
```

- `q`: o que procurar, em inglês quando possível (`whoosh`, `rain`, `click`, `applause`, `door slam`).
- `license_type=commercial`: só arquivos que podem ser usados em trabalho comercial.
- `license=cc0`: só domínio público (não precisa de linha de atribuição).
- `page_size`: até 20 sem cadastro; a paginação é limitada.

A resposta é JSON: `result_count`, `page_count` e `results[]`. Cada resultado traz:

- `url`: o arquivo para baixar (link direto).
- `title`, `creator`: o nome do som e quem gravou.
- `license`, `license_url`: a licença do arquivo (ex.: `cc0`, `by`, `by-sa`, `by-nc`).
- `source`: de onde o arquivo veio (ex.: `jamendo`).
- `duration`: a duração em milissegundos.
- `filesize`, `filetype`: o tamanho e o formato.
- `tags`: palavras que descrevem o som.
- `attribution`: a linha de atribuição pronta para copiar.
- `alt_files`: outros formatos do mesmo som (wav, flac) quando existem.

## Como escolher

- Leia o título, as tags e a duração: o som certo é o que combina com o momento (um `whoosh` curto para um corte, um `rain` longo para um ambiente).
- Não confie só no nome do arquivo: o título e as tags dizem mais, e a duração e o tamanho confirmam.
- Prefira CC0 quando houver um bom: não precisa de linha de atribuição.
- Se o usuário disser que o uso é comercial, use `license_type=commercial`. Se não souber se o uso é comercial, pergunte antes de baixar.

## Como baixar

Baixe pelo link direto do campo `url` e salve na pasta de sons do projeto (ex.: `sfx/`):

```
curl -L -o sfx/whoosh.mp3 "<url>"
```

Quando precisar de WAV (edição no vídeo), use o link de `alt_files` no formato `wav`.

## Licença e atribuição

Cada arquivo tem a própria licença. Regras:

- **CC0 (domínio público)**: não precisa de linha de atribuição.
- **CC BY e CC BY-SA**: precisam da linha de atribuição — copie a string do campo `attribution` do resultado.
- **NC (não comercial)**: não pode ser usado em trabalho comercial.
- **ND (sem derivados)**: não pode ser alterado — pule-o quando o som for ser cortado ou mixado.

Anote no relatório de cada som: título, quem gravou, licença e a linha de atribuição (quando a licença pedir).

## Limites

- Sem cadastro: `page_size` até 20 e paginação limitada.
- Os termos do Openverse proíbem varredura e download em massa: use a busca para achar os arquivos que o projeto precisa, não para baixar o catálogo.
- Se a API não responder, diga isso e continue com o que você tem — nunca trave o turno por causa da busca.

## Quando usar

- O usuário pede um som, um efeito, uma música ou um ambiente.
- Um vídeo precisa de som e não há biblioteca local.
- A skill de som do vídeo (real-sfx) precisa de um som e não há biblioteca local: busque aqui primeiro.
