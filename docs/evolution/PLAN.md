# Devanity — Plano

Companheiro de [SPEC.md](SPEC.md): a SPEC diz o que o devanity é; este arquivo diz onde o trabalho está e o que vem a seguir. Cada fase vive numa issue, com suas tarefas, critérios de aceite, status e decisões datadas; aqui ficam o estado, a ordem e as regras que atravessam fases. A história das fases F0–O (61 tarefas, 69 decisões) está no histórico git deste arquivo até `6a1ac85`.

## Estado (2026-10-14)

- **v1 convergida** (SPEC §0): kernel, modos, guards, oracle, ledger, job de CI de referência, harness.
- **Fase O** (operabilidade por IA, [#40](https://github.com/usedevanity/skills/issues/40)): `done`; O5 (medição `operability-uplift`) adiada para a rodada viva.
- **Fase A** (atenção como recurso, [#44](https://github.com/usedevanity/skills/issues/44)): implementação em `main` (#45–#50); falta A0.3, a linha de base de uso real, que julga a fase.
- **Medição viva suspensa** (decisão de 2026-10-02): nenhuma tarefa afirma melhora de eficácia até a reativação; o que a prova é o verifier de contexto limpo, os testes e o `review`.

## Próximo, nesta ordem

1. **A0.3** (mantenedor): 3–4 marcos reais com o plugin ativo (um com UI, um que cruza módulos, um de auth). `ledger stats` dá três das quatro contagens (`attention`, `cost`, `scope coverage`); o rótulo novo/derivável de cada decisão é manual. Resultado em `evals/results/<data>-attention-baseline.md`; é o número que fecha a fase A contra os critérios da #44.
2. **Reativar a rodada viva** (F1.13): destrava O5 e volta a ler o alerta permanente (abaixo). Gate: SPEC §13.
3. **F4, calibração e compressão**, só com SPEC §13 verde: F4.1 calibração no install (3 sondas; em Haiku `false_ready` cai, senão remover); F4.2 compressão medida das referências (gramática inalterada, tokens −30% sem regressão); F4.3 outros hosts só com `AGENTS.md` gerado e nenhum hook sem medição no host.

Uma fase B só se desenha a partir do que A0.3 mostrar.

## Regras que atravessam fases

- **Pronto** = critério de aceite executado pelo revisor, testes e validadores verdes, nada fora do escopo; `plugin/hooks/**`, `plugin/scripts/**` e `scripts/**` são `high-risk`: cada tarefa é PR aprovada pelo mantenedor, com `devanity-proof`, verifier de contexto limpo e `review` no corpo.
- **O que já foi medido é lei até ser medido de novo:** a ordem do bloco Decisions do kernel (human-owned antes de reversível); as cláusulas de D2 (inventar regra conta, constante não é reversibilidade, fatia parada é stub que falha); D1 look-first; o bloco `devanity-proof` e o `devanity-contract`; `by: human` só via `/devanity decide`.
- **Nunca:** dependência nova; frase nova no kernel (`SKILL.md` só por troca; o byte ratchet de `validate.mjs` sobe no mesmo diff que cresce a skill); campo obrigatório novo nos schemas; enfraquecer um verificador para ficar verde.
- **Parar uma fase** quando o gate não fecha após duas iterações com evidência nova; a terceira exige decisão registrada (mudar o gate ou o desenho), nunca uma tentativa silenciosa.
- **Alerta permanente:** texto crescendo em `SKILL.md` sem melhora no harness é regressão, mesmo com CI verde. Lido na rodada que reativar a medição.

## Dependências

```
F0 → F1 → F2 → F3 → Consolidação → V → O → A → F1.13 (rodada de referência) → F4
```
