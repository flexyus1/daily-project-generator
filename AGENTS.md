SEMPRE SIGA AO PÉ DA LETRA O QUE EU MANDAR FAZER, NÃO INVENTE COISAS

# Guia dos Agentes

## Quando estiver em dúvida
- Leia este arquivo do início ao fim antes de tomar qualquer decisão.
- Se ainda restar dúvida, confirme diretamente com o usuário antes de agir.

## Diretrizes para Geração Automática de Previews (Provider)
- **Variedade mínima por execução**: variar 2–3 eixos (ex.: uma cor-acento, uma variação de layout, reordenação de módulos em 20–40%). Tipografia base, navegação e CTAs permanecem fixos.
- **Performance alvo**: LCP ≤ 2,5 s (mobile), INP ≤ 200 ms, CLS ≤ 0,1; animações a 60 fps (≤ 10 ms/frame). Orçamentos máximos: JS ≤ 50 KB gzip, imagens ≤ 150 KB. Respeitar `prefers-reduced-motion`.
- **Proporção reutilização/inovação**: 70% elementos reciclados, 30% elementos novos a cada execução.
- **Temas**: escolher somente a partir de um catálogo curado com 5–7 temas e pesos definidos; nada totalmente livre.
- **Limites da aleatoriedade**: não mover navegação, CTAs ou formulários. Manter contraste ≥ 4,5:1. Variação de fontes limitada a ±1 nível tipográfico. Movimento ≤ 12 px e ≤ 300 ms. Grid e hierarquia devem permanecer estáveis.
- **Elementos randomizáveis**: ícones decorativos, ilustrações, gradientes, padrões, imagens de capa, microinterações não críticas. Não randomizar estrutura de formulários, ordem de navegação ou tamanhos de botões.
- **Dados e metadados disponíveis**: seed determinística, hora do dia, tema, modo/jogador, classe de dispositivo, locale/idioma, modo claro/escuro, bucket A/B. Nunca usar ou inferir PII.
- **Controle de repetição**: manter cache LRU de combinações; bloquear repetições idênticas nas últimas 50 execuções; garantir distância de cor ΔE ≥ 10 e ao menos uma variação de layout.
- **Fixar combinações**: oferecer botão “Fixar” que salva seed+config, exporta JSON e gera permalink; permitir ajuste de pesos após fixar.
- **Referências visuais**: Coolors, Haikei, Patternpad, BGJar, LottieFiles Randomizer, Doodle Ipsum, Material Theme Builder.

## Estrutura e Conteúdo do `AGENTS.md`
- **Objetivo**: servir como onboarding rápido e fonte única de como rodar, depurar e estender agentes.
- **Nível de detalhe esperado**: para cada agente listar propósito, entradas/saídas, ferramentas, estados, gatilhos, limites, métricas e owners (1–2 páginas por agente).
- **Função**: guia de criação e troubleshooting; histórico deve ir para `CHANGELOG.md`.
- **Dores atuais a corrigir**: dificuldade em localizar seções, linguagem inconsistente, falta de exemplos e fluxos, passos desatualizados.
- **Estilo de documentação**: instruções prescritivas para caminhos críticos; explicações conceituais para racional e anti-padrões.
- **Decisões urgentes a registrar**: privacidade/redação de logs, estratégia de retries/backoff, timeouts, limites de tokens/custos, escalonamento humano, versionamento de prompts, convenções de nomes, schema de mensagens, catálogo de erros.
- **Organização sugerida**: seções globais (arquitetura, padrões, segurança) seguidas de blocos por agente → tarefas → playbooks → troubleshooting → referências.
- **Exemplos úteis obrigatórios**: fluxos input→output reais, snippets de prompt, YAML de configuração, traces de mensagens, erros comuns com correções, testes de contrato, templates reutilizáveis.
- **Formatos preferidos**: checklists, fluxogramas simples, listas passo a passo, snippets inline. Use diagramas de sequência apenas quando necessário.
- **Stakeholders adicionais**: Produto/Design, SRE/Infra, Segurança/Privacidade, Suporte e Compliance. Documentar requisitos de observabilidade, quotas, dados, auditabilidade e rollback para atender todos.
