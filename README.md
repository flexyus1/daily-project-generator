# Projeto (nome a definir)

Status: em definição. Este repositório foi inicializado com uma base de higiene (configs, CI esqueleto e templates) para acelerar a fase de descoberta e escolhas de stack.

## Objetivo (TBD)
- Preencher propósito, público-alvo e primeiros casos de uso.
- Registrar decisões em ADRs em `docs/adr/` (ver 0001 e o template).

## Como começar
- Decidir o artefato inicial (CLI, serviço web, lib, UI, etc.).
- Abrir/atualizar ADRs para stack e políticas (MADR em `docs/adr`).
- Seguir convenções de branches e commits (abaixo) e abrir PRs.

## Ambiente local (opcional)
- Copie `.env.example` para `.env.local` e ajuste variáveis se necessário:
  - `PORT` (porta do dev server)
  - `USE_PREVIEW2_GENERATION` (liga/desliga geração diária local)
  - `OPENAI_*` (apenas se quiser usar o provider GPT; não comitar chaves)
- Requisitos: Node.js 20 LTS.
- Comandos:
  - `npm start` — sobe um servidor simples que serve `public/` e gera um preview diário autocontido (sem backend). Útil apenas como playground visual enquanto o propósito do projeto é definido.

## Convenções
- Versionamento: SemVer via tags `vX.Y.Z`.
- Commits: Conventional Commits com DCO (assinar com `--signoff`).
- Branches: `feature/<nome>`, `fix/<bug>`; PR obrigatório.

## Qualidade e estilo
- Formatação: Prettier (MD/YAML/JSON/JS/TS), Black+isort (Py).
- Lint: ESLint (TS/JS), Ruff (Py), golangci-lint (Go).
- Tipagem: TS strict; mypy/pyright strict (Py).
- Testes: cobertura mínima 85% (crítico ≥90%).

Veja `AGENTS.md` para políticas completas e roadmap de CI/CD.

## Estrutura inicial
- `docs/adr/` — decisões arquiteturais (MADR).
- `.github/workflows/ci.yml` — CI esqueleto com verificações condicionais.
- Configs de editor/formatadores: `.editorconfig`, `.prettierrc.json`.
- Configs opcionais por linguagem (ex.: `pyproject.toml`, `eslint.config.mjs`, `tsconfig.base.json`).
 - `public/` — assets de preview local e servidor de desenvolvimento (`public/scripts/dev-server.mjs`).

## Contribuindo
Leia `CONTRIBUTING.md` para fluxo de trabalho, DCO e checklist de PR.
