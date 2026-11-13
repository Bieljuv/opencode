---
name: strix
description: "Audita a segurança de um sistema ou site antes de entregar: acha vulnerabilidades com prova, prioriza pelo impacto real, corrige e retesta. Use quando o usuário pedir auditoria de segurança, pentest, blindar o projeto, revisar a segurança, ou disser /strix, 'auditoria de segurança', 'pentest', 'blindar o projeto', 'acha as falhas', 'revisar a segurança', 'vulnerabilidade', 'antes de entregar'. Gatilhos: strix, auditoria de segurança, pentest, blindar o projeto, blindar, acha as falhas, revisar a segurança, vulnerabilidade, falha de segurança, antes de entregar."
argument-hint: "[o que auditar, ex.: o sistema atual, a rota de login]"
---

# /strix

Quando o usuário pedir uma auditoria de segurança — ou rodar /strix — rode esta auditoria antes de entregar o sistema ou site. Ela NÃO é automática em toda entrega: antes de entregar, OFEREÇA a auditoria ao usuário e rode só se ele pedir ou aceitar. Nunca rode a auditoria completa sem o usuário pedir ou aceitar.

MÉTODO (igual ao de uma plataforma de pentest: achar, provar, priorizar, corrigir, retestar):
1. ACHE: varra o código e as rotas nestes pontos — segredos hardcoded (chave/token/senha no código); autenticação (sessão, JWT, hash de senha, expiração); autorização (um usuário/tenant alcançando dado de outro — em sistema multi-empresa, filial vendo dado de outra filial é falha crítica); injeção (SQL, XSS, comando); SSRF (URL vinda do usuário: só hosts numa allowlist explícita, nunca IP privado/interno, só HTTPS); upload de arquivo (tipo, tamanho, execução); dependências conhecidamente vulneráveis; headers e rate limit.
2. PROVE: cada achado precisa de prova reproduzível (requisição, resposta, trecho de código) — achado sem prova é suspeita, não falha. Reproduza sem quebrar nada: nunca apague, altere ou exponha dado real pra "provar".
3. PRIORIZE pelo impacto real: o que expõe dado, permite acesso indevido ou derruba o sistema vem primeiro; o resto vai pro fim da lista.
4. CORRIJA com a ferramenta de edição e RETESTE: a falha só sai da lista depois do reteste confirmar que sumiu.
5. ENTREGUE o relatório: falhas encontradas (com prova), corrigidas e retestadas, e as restantes com o risco explicado — o usuário decide o que aceita.

STRIX (quando o cliente já tem acesso): a plataforma Strix (strix.ai) faz esse mesmo trabalho de forma contínua — pentest de código, APIs, web apps e infra, cada achado com prova de exploração e PR de correção. Se o cliente já tem acesso à Strix, use os achados dela como a entrada desta auditoria — mas revise cada correção antes de aceitar, como qualquer PR. Sem acesso, faça a auditoria com as próprias ferramentas.
REGRAS DURAS: só audite sistemas que o usuário possui ou tem autorização pra testar; nunca teste alvo de terceiros; nunca use uma falha pra acessar dado real além da prova mínima. (Metodologia inspirada na plataforma Strix.)
