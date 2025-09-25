import { createServer } from 'http';
import { readFile, writeFile, stat, mkdir, rename } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Load .env and .env.local (dev only), without overriding existing env vars
async function loadEnvFiles() {
  const files = ['.env', '.env.local'];
  for (const file of files) {
    try {
      const envPath = path.resolve(rootDir, '..', file);
      const raw = await readFile(envPath, 'utf8');
      raw.split(/\r?\n/).forEach((line) => {
        const s = line.trim();
        if (!s || s.startsWith('#')) return;
        const idx = s.indexOf('=');
        if (idx === -1) return;
        const key = s.slice(0, idx).trim();
        let val = s.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      });
    } catch {}
  }
}

await loadEnvFiles();

const PORT = Number(process.env.PORT || 3000);
// Default: ON. Set USE_PREVIEW2_GENERATION=0/false to disable.
const RAW_PREVIEW_FLAG = String(process.env.USE_PREVIEW2_GENERATION ?? '1').toLowerCase();
const USE_PREVIEW2_GENERATION = ['1', 'true', 'on', 'yes'].includes(RAW_PREVIEW_FLAG);

const GPT_KEY = (process.env.OPENAI_API_KEY || '').trim();
const RAW_GPT_FLAG = String(process.env.USE_GPT_PREVIEW2 ?? process.env.USE_GPT ?? '').trim().toLowerCase();
const GPT_FLAG_RESOLVED = RAW_GPT_FLAG ? ['1', 'true', 'on', 'yes'].includes(RAW_GPT_FLAG) : Boolean(GPT_KEY);
const USE_GPT_PREVIEW2 = Boolean(GPT_KEY && GPT_FLAG_RESOLVED);

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8']
]);

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME.get(ext) || 'application/octet-stream';
}

function safeJoin(base, target) {
  // Normalize absolute paths like "/src/..." to be relative to base
  const rel = target.startsWith('/') ? target.slice(1) : target;
  const resolvedPath = path.normalize(path.join(base, rel));
  if (!resolvedPath.startsWith(base)) {
    return null; // directory traversal attempt
  }
  return resolvedPath;
}

// --- Preview 2: geração diária (UTC) ---
const PREVIEW2_PATH = path.join(rootDir, 'src', 'previews', 'preview-2.html');
const PREVIEW2_CACHE_JSON = path.join(rootDir, 'src', 'previews', '.preview-2-cache.json');

async function todayUtcKey() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function ideaSeedFromDate(key) {
  // Simple deterministic seed from date key
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 33 + key.charCodeAt(i)) >>> 0;
  return h;
}

function pick(list, seed) {
  return list[seed % list.length];
}

function generateIdeaLocally(key) {
  // Fallback local idea generator (no network). Deterministic per UTC day.
  const seed = ideaSeedFromDate(key);
  const domains = [
    { name: 'Produtividade', why: 'ajuda a organizar o dia e manter o foco.' },
    { name: 'Saúde', why: 'promove hábitos saudáveis com metas simples.' },
    { name: 'Estudos', why: 'facilita revisão e prática constante.' },
    { name: 'Finanças', why: 'torna controle de gastos acessível e claro.' },
    { name: 'DevTools', why: 'agiliza tarefas repetitivas do desenvolvedor.' },
  ];
  const ideas = [
    { title: 'Tracker de Hábitos Minimalista', slug: 'habit-tracker' },
    { title: 'Timer Pomodoro com Relatórios', slug: 'pomodoro-tracker' },
    { title: 'Lista de Tarefas por Prioridade', slug: 'priority-todo' },
    { title: 'Orçamento Semanal Simples', slug: 'weekly-budget' },
    { title: 'Flashcards de Terminal', slug: 'term-flashcards' },
    { title: 'Gerador de README Inicial', slug: 'readme-seed' },
    { title: 'Checklist de Deploy', slug: 'deploy-checklist' },
  ];
  const features = [
    'CRUD básico (criar, listar, editar, excluir)',
    'Persistência local (LocalStorage/JSON) sem backend',
    'Filtros e busca simples',
    'Exportar/Importar dados (.json)',
    'Atalhos de teclado',
    'Tema claro/escuro',
  ];
  const domain = pick(domains, seed);
  const idea = pick(ideas, seed >>> 3);
  const rawFeatures = [
    pick(features, seed >>> 5),
    pick(features.slice().reverse(), seed >>> 7),
    pick(features.slice(1), seed >>> 9)
  ];
  const uniqueFeatures = Array.from(new Set(rawFeatures.filter(Boolean)));
  while (uniqueFeatures.length < 3) {
    uniqueFeatures.push(features[(seed >>> (11 + uniqueFeatures.length)) % features.length]);
    uniqueFeatures.splice(0, uniqueFeatures.length, ...new Set(uniqueFeatures));
  }

  const data = {
    key,
    title: idea.title,
    domain: domain.name,
    why: domain.why,
    features: uniqueFeatures.slice(0, 3),
    slug: idea.slug,
  };
  return data;
}

// Escreve arquivo de forma atômica e apenas se o conteúdo mudar
async function atomicWriteIfChanged(filePath, content, encoding = 'utf8') {
  let current = null;
  try {
    current = await readFile(filePath, encoding);
  } catch {}
  if (current === content) return false; // sem mudança
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.tmp-${process.pid}`);
  await mkdir(dir, { recursive: true });
  await writeFile(tmp, content, encoding);
  await rename(tmp, filePath); // rename é atômico na maioria dos FS
  return true;
}

// --- Geração procedural de templates locais ---

function createSeededRng(seed) {
  let state = seed || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomPick(list, rng) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const index = Math.floor(rng() * list.length);
  return list[index];
}

function pickMany(list, count, rng) {
  const pool = Array.isArray(list) ? list.slice() : [];
  const result = [];
  while (result.length < count && pool.length) {
    const idx = Math.floor(rng() * pool.length);
    result.push(pool.splice(idx, 1)[0]);
  }
  return result;
}

function makeId(prefix, rng) {
  const suffix = Math.floor(rng() * 1e9).toString(36);
  return `${prefix}-${suffix}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hexToRgba(hex, alpha) {
  let value = hex.replace('#', '');
  if (value.length === 3) {
    value = value.split('').map((c) => c + c).join('');
  }
  const int = parseInt(value, 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const LOCAL_CHAMPION_POOL = [
  'Ahri','Akali','Ashe','Braum','Camille','Corki','Darius','Ekko','Elise','Ezreal','Garen','Irelia','Janna','Jax','Jinx','Kai\'Sa','Kassadin','Kindred','Lee Sin','Leona','Lissandra','Lulu','Lux','Nami','Orianna','Renekton','Sejuani','Senna','Seraphine','Sett','Sivir','Thresh','Tristana','Vel\'Koz','Vi','Viktor','Xayah','Yasuo','Zed'
];

const TRAINING_RITUALS = [
  'Revisar bans prioritários com o time',
  'Simular fase 1 do draft em 5 minutos',
  'Mapear counters críticos para hoje',
  'Sincronizar chamadas de visão ofensiva',
  'Definir respostas rápidas a picks surpresa',
  'Ajustar runas e feitiços padrão',
  'Ensaiar rotação de objetivo aos 6 minutos',
  'Validar sinais do shotcaller',
  'Checar campeões em ascensão nos últimos jogos',
  'Planejar power spikes por rotação',
  'Configurar prioridades de ban em scrims',
  'Documentar plano de mid game' 
];

const FOCUS_POINTS = [
  'Controle de wave pré-objetivo',
  'Execução de dive coordenado',
  'Contestação de visão defensiva',
  'Macro call após pickoff',
  'Rotação rápida para Arauto',
  'Sincronização de temporizadores',
  'Comunicação de cooldowns-chave',
  'Cobertura de invade inicial',
  'Setups de flanco para luta',
  'Fechamento de partida com barão',
  'Proteção ao carry principal',
  'Reset inteligente pós teamfight'
];

const DAILY_PROMPTS = [
  'Qual adversário merece atenção extra?',
  'Quais bans mudam com a atualização recente?',
  'Que chamada queremos repetir hoje?',
  'Onde perdemos tempo nos últimos treinos?',
  'Qual condição de vitória vamos perseguir?',
  'Quais sinais precisamos ouvir mais?',
  'Qual duelo determinou a última derrota?',
  'Onde estão nossos melhores power spikes?',
  'Qual estatística queremos subir hoje?',
  'O que fazer se o draft sair do plano?'
];

const REVIEW_QUESTIONS = [
  'Qual call funcionou melhor ontem?',
  'Onde perdemos visão de mapa?',
  'Quem lidera a comunicação de mid game?',
  'Quais counters surpreenderam o time?',
  'Como foi a transição de lane para rotações?',
  'Quais objetivos conquistamos com vantagem?',
  'Qual foi o erro mais caro da última série?',
  'O que precisa de reforço no próximo bloco?'
];

const METRIC_OPTIONS = [
  'Execução de plano de draft',
  'Coordenação de rotações',
  'Controle de visão contestada',
  'Consistência de call principal',
  'Ajuste rápido a picks surpresa',
  'Tempo de resposta pós objetivo',
  'Sincronização de cooldowns',
  'Energia e foco entre partidas'
];

const SCORE_BENCHMARKS = [
  'Meta: 4/5 ao final do dia',
  'Rever com coach se < 3',
  'Checar VOD após scrim',
  'Documentar aprendizados imediatos',
  'Transformar em call padrão',
  'Simular em modo treino'
];

const POWER_LINES = [
  'Transforme cada draft em plano acionável.',
  'Micro decisões alinhadas ao macro do time.',
  'Disciplina diária gera vitórias consistentes.',
  'Visualize, planeje e execute sem fricção.',
  'Informações de draft virando hábitos reais.',
  'Treinos com foco cirúrgico nas próximas partidas.'
];

const MINIMAL_SIGNALS = [
  'tom calmo',
  'voz objetiva',
  'ênfase direta',
  'leitura suave',
  'respiro generoso',
  'ritmo cadenciado',
  'equilíbrio visual',
  'gesto único'
];

const MINIMAL_FOCUS_LINES = [
  'Destacar apenas a ação principal da experiência.',
  'Reduzir o layout a blocos curtos e alinhados.',
  'Utilizar espaços vazios como parte da hierarquia.',
  'Resumir a proposta em até uma frase objetiva.',
  'Evitar elementos decorativos que não guiam decisões.',
  'Aplicar o mesmo ritmo de leitura em todas as seções.',
  'Limitar cada bloco a uma ideia autoexplicativa.',
  'Garantir contraste confortável entre texto e fundo.'
];

const MINIMAL_TOUCHPOINTS = [
  'Anunciar o propósito em uma linha.',
  'Apresentar o resultado esperado para o dia.',
  'Convidar para um acompanhamento discreto.',
  'Mostrar o próximo passo sem urgência.',
  'Reservar espaço para notas curtas do time.',
  'Registrar um lembrete leve para revisões.',
  'Celebrar pequenas vitórias sem exageros.',
  'Fechar com um convite à reflexão final.'
];

const MINIMAL_PROMPTS = [
  'O que precisa ser percebido imediatamente?',
  'Qual sensação queremos entregar no encerramento?',
  'O que pode ser removido sem perder valor?',
  'Como o olhar percorre o conteúdo em três passos?',
  'Qual palavra resume o propósito de hoje?',
  'Que sinal indica sucesso ao usuário?',
  'Há ruídos visuais que atrapalham a leitura?',
  'Como garantimos intervalos para respirar?' 
];

const MINIMAL_REFLECTIONS = [
  'Validar o fluxo com alguém que não conhece o projeto.',
  'Registrar impressões rápidas logo após a visualização.',
  'Compartilhar a narrativa em uma reunião de cinco minutos.',
  'Anotar ruídos percebidos durante a leitura.',
  'Salvar uma captura para comparar evoluções futuras.',
  'Listar dúvidas que precisam de resposta amanhã.',
  'Marcar quem deve revisar antes da próxima entrega.',
  'Definir um gatilho simples para medir impacto.'
];

const FONT_STACKS = [
  { body: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif', heading: '"Space Grotesk", system-ui, sans-serif' },
  { body: '"Manrope", system-ui, -apple-system, "Segoe UI", sans-serif', heading: '"Manrope", system-ui, sans-serif' },
  { body: 'system-ui, -apple-system, "Segoe UI", sans-serif', heading: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
  { body: '"Work Sans", system-ui, sans-serif', heading: '"Work Sans", system-ui, sans-serif' },
  { body: '"Source Sans Pro", system-ui, sans-serif', heading: '"Poppins", system-ui, sans-serif' },
  { body: '"IBM Plex Sans", system-ui, sans-serif', heading: '"IBM Plex Sans Condensed", system-ui, sans-serif' },
  { body: '"Merriweather", Georgia, serif', heading: '"Playfair Display", Georgia, serif' }
];

const THEME_PRESETS = [
  {
    id: 'nebula',
    base: '#050910',
    surface: '#0b1629',
    panel: '#101f37',
    surfaceSoft: '#0f1a33',
    text: '#e5e7eb',
    muted: 'rgba(148, 163, 184, 0.82)',
    border: 'rgba(56, 189, 248, 0.24)',
    accents: ['#38bdf8', '#22d3ee', '#60a5fa'],
    highlights: ['#f472b6', '#a855f7', '#f97316'],
    backgroundLayers: [
      { shape: 'radial', size: '1050px 720px', position: '-12% -18%', color: 'accent', stop: '60%' },
      { shape: 'radial', size: '820px 640px', position: '118% -24%', color: 'highlight', stop: '64%' }
    ],
    shadow: '0 28px 60px rgba(15, 23, 42, 0.52)',
    success: '#34d399',
    warning: '#f97316'
  },
  {
    id: 'solstice',
    base: '#f8fafc',
    surface: '#ffffff',
    panel: '#f1f5f9',
    surfaceSoft: '#e2e8f0',
    text: '#0f172a',
    muted: 'rgba(71, 85, 105, 0.82)',
    border: 'rgba(148, 163, 184, 0.35)',
    accents: ['#2563eb', '#0ea5e9', '#f97316'],
    highlights: ['#22c55e', '#8b5cf6', '#facc15'],
    backgroundLayers: [
      { shape: 'radial', size: '980px 660px', position: '-18% -22%', color: 'accent', stop: '64%' },
      { shape: 'radial', size: '860px 700px', position: '112% -18%', color: 'highlight', stop: '68%' }
    ],
    shadow: '0 24px 52px rgba(15, 23, 42, 0.12)',
    success: '#16a34a',
    warning: '#dc2626'
  },
  {
    id: 'ember',
    base: '#1b0f12',
    surface: '#26141a',
    panel: '#301a21',
    surfaceSoft: '#3a222b',
    text: '#f8fafc',
    muted: 'rgba(249, 168, 212, 0.86)',
    border: 'rgba(248, 113, 113, 0.28)',
    accents: ['#fb7185', '#f97316', '#f43f5e'],
    highlights: ['#a855f7', '#22d3ee', '#facc15'],
    backgroundLayers: [
      { shape: 'radial', size: '960px 640px', position: '-10% -18%', color: 'accent', stop: '58%' },
      { shape: 'radial', size: '780px 600px', position: '118% -20%', color: 'highlight', stop: '64%' }
    ],
    shadow: '0 32px 68px rgba(12, 10, 14, 0.62)',
    success: '#34d399',
    warning: '#f97316'
  },
  {
    id: 'forest',
    base: '#0f1712',
    surface: '#132015',
    panel: '#1a2c1d',
    surfaceSoft: '#213723',
    text: '#e2f5e9',
    muted: 'rgba(148, 225, 179, 0.82)',
    border: 'rgba(56, 189, 148, 0.28)',
    accents: ['#34d399', '#22c55e', '#4ade80'],
    highlights: ['#38bdf8', '#f97316', '#facc15'],
    backgroundLayers: [
      { shape: 'radial', size: '960px 700px', position: '-14% -22%', color: 'accent', stop: '60%' },
      { shape: 'radial', size: '840px 660px', position: '118% -18%', color: 'highlight', stop: '64%' }
    ],
    shadow: '0 28px 62px rgba(7, 32, 18, 0.58)',
    success: '#22c55e',
    warning: '#fbbf24'
  }
];

const PHASE_BLUEPRINTS = [
  { name: 'Scouting Rápido', tasks: ['Revisar histórico do adversário', 'Checar jogos recentes', 'Marcar picks surpresa'] },
  { name: 'Pré-draft', tasks: ['Definir bans obrigatórios', 'Listar flex picks seguros', 'Alinhar prioridades por rota'] },
  { name: 'Fase 1 do Draft', tasks: ['Confirmar first pick', 'Monitorar respostas do rival', 'Registrar ajustes imediatos'] },
  { name: 'Fase 2 do Draft', tasks: ['Proteger condição de vitória', 'Evitar comp de poke forte', 'Checar sinergias finais'] },
  { name: 'Plano de Mid Game', tasks: ['Planejar setup de visão', 'Organizar janelas de rotação', 'Mapear timers de objetivo'] },
  { name: 'Plano de Late Game', tasks: ['Delegar shotcall', 'Evitar coin flips', 'Forçar lutas em zona favorável'] },
  { name: 'Revisão Pós-jogo', tasks: ['Salvar clipes relevantes', 'Registrar aprendizados', 'Definir ação imediata'] },
  { name: 'Mental Reset', tasks: ['Respirar 2 minutos', 'Reforçar ponto forte', 'Acordar plano do próximo mapa'] }
];

function createTheme(rng) {
  const preset = randomPick(THEME_PRESETS, rng) || THEME_PRESETS[0];
  const accent = randomPick(preset.accents, rng) || preset.accents[0];
  const highlightChoices = preset.highlights.filter((c) => c !== accent);
  const highlight = randomPick(highlightChoices, rng) || preset.highlights[0];
  const accentSoft = hexToRgba(accent, 0.22);
  const highlightSoft = hexToRgba(highlight, 0.20);
  const layers = (preset.backgroundLayers || []).map((layer) => {
    const color = layer.color === 'highlight' ? highlightSoft : accentSoft;
    return `${layer.shape}-gradient(${layer.size} at ${layer.position}, ${color}, transparent ${layer.stop})`;
  });
  const background = `${layers.join(', ')}, ${preset.base}`;
  const font = randomPick(FONT_STACKS, rng) || FONT_STACKS[0];
  return {
    id: preset.id,
    background,
    base: preset.base,
    surface: preset.surface,
    panel: preset.panel,
    surfaceSoft: preset.surfaceSoft,
    text: preset.text,
    muted: preset.muted,
    border: preset.border,
    accent,
    accentSoft,
    accentStrong: hexToRgba(accent, 0.36),
    highlight,
    highlightSoft,
    shadow: preset.shadow,
    success: preset.success,
    warning: preset.warning,
    font
  };
}

function ensureFeatureList(features, rng) {
  const base = Array.isArray(features) ? features.filter(Boolean) : [];
  const pool = Array.from(new Set([...TRAINING_RITUALS, ...FOCUS_POINTS]));
  while (base.length < 4) {
    const candidate = randomPick(pool, rng);
    if (candidate && !base.includes(candidate)) base.push(candidate);
  }
  return base.slice(0, 4);
}

function buildEssenceCard(ctx) {
  const { rng } = ctx;
  const signal = randomPick(MINIMAL_SIGNALS, rng) || MINIMAL_SIGNALS[0];
  const highlights = pickMany(MINIMAL_FOCUS_LINES, 3, rng);
  const items = highlights.map((line) => `<li>${escapeHtml(line)}</li>`).join('\n');
  return {
    html: `<section class="card card--essence">
      <header class="card__head">
        <h2>Essência do dia</h2>
        <span class="pill">${escapeHtml(signal)}</span>
      </header>
      <ul class="list">
        ${items}
      </ul>
    </section>`,
    script: ''
  };
}

function buildRhythmCard(ctx) {
  const { rng } = ctx;
  const steps = pickMany(MINIMAL_TOUCHPOINTS, 4, rng);
  const vibe = randomPick(MINIMAL_SIGNALS, rng) || MINIMAL_SIGNALS[1];
  const mantra = randomPick(POWER_LINES, rng) || POWER_LINES[0];
  const stepsHtml = steps
    .map((step, index) => `<li>
        <strong>${String(index + 1).padStart(2, '0')}</strong>
        <span>${escapeHtml(step)}</span>
      </li>`)
    .join('\n');
  return {
    html: `<section class="card card--rhythm">
      <header class="card__head">
        <h2>Ritmo sugerido</h2>
        <span class="pill pill--subtle">${escapeHtml(vibe)}</span>
      </header>
      <ol class="steps">
        ${stepsHtml}
      </ol>
      <p class="card__note">${escapeHtml(mantra)}</p>
    </section>`,
    script: ''
  };
}

function buildPromptCard(ctx) {
  const { rng } = ctx;
  const prompts = pickMany(MINIMAL_PROMPTS, 4, rng);
  const tag = randomPick(MINIMAL_SIGNALS, rng) || MINIMAL_SIGNALS[2];
  const promptsHtml = prompts
    .map((prompt) => `<li>${escapeHtml(prompt)}</li>`)
    .join('\n');
  return {
    html: `<section class="card card--prompts">
      <header class="card__head">
        <h2>Perguntas de alinhamento</h2>
        <span class="pill">${escapeHtml(tag)}</span>
      </header>
      <ul class="questions">
        ${promptsHtml}
      </ul>
    </section>`,
    script: ''
  };
}

function buildReflectionCard(ctx) {
  const { rng } = ctx;
  const actions = pickMany(MINIMAL_REFLECTIONS, 3, rng);
  const label = randomPick(MINIMAL_SIGNALS, rng) || MINIMAL_SIGNALS[3];
  const actionsHtml = actions
    .map((action) => `<li>${escapeHtml(action)}</li>`)
    .join('\n');
  return {
    html: `<section class="card card--reflection">
      <header class="card__head">
        <h2>Próximos cuidados</h2>
        <span class="pill pill--outline">${escapeHtml(label)}</span>
      </header>
      <ul class="list list--dense">
        ${actionsHtml}
      </ul>
    </section>`,
    script: ''
  };
}

const MODULE_BUILDERS = [
  buildEssenceCard,
  buildRhythmCard,
  buildPromptCard,
  buildReflectionCard
];

function renderProceduralShell({ key, idea, theme, modules, columns, features, motto }) {
  const safeTitle = escapeHtml(idea.title || 'Projeto do Dia');
  const safeDomain = escapeHtml(idea.domain || 'Domínio');
  const safeWhy = escapeHtml(idea.why || 'Plano diário para evoluir decisões de draft.');
  const modulesHtml = modules.map((module) => module.html).join('\n');
  const moduleScripts = modules
    .map((module) => (module.script ? module.script.trim() : ''))
    .filter(Boolean)
    .join('\n');
  const featureData = JSON.stringify(features);
  const mantra = escapeHtml(motto);
  const today = escapeHtml(key);
  const headingFont = theme.font?.heading || 'inherit';
  const bodyFont = theme.font?.body || 'system-ui, sans-serif';
  const inlineScripts = moduleScripts ? `${moduleScripts}\n` : '';

  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      :root {
        --base: ${theme.base};
        --surface: #ffffff;
        --text: ${theme.text};
        --muted: rgba(15, 23, 42, 0.58);
        --accent: ${theme.accent};
        --line: rgba(15, 23, 42, 0.12);
        --soft: rgba(15, 23, 42, 0.04);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: #f6f7f8;
        color: var(--text);
        font: 15px/1.6 ${bodyFont};
      }
      a.back {
        position: fixed;
        top: 24px;
        left: 24px;
        text-decoration: none;
        color: var(--text);
        font-size: 0.82rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      a.back::before { content: '← '; }
      .wrap {
        max-width: 880px;
        margin: 0 auto;
        padding: 72px 24px 56px;
      }
      .hero {
        display: flex;
        flex-direction: column;
        gap: 16px;
        margin-bottom: 40px;
      }
      .hero__meta {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
        flex-wrap: wrap;
      }
      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.18em;
        font-size: 0.74rem;
        color: var(--muted);
      }
      .hero h1 {
        margin: 0;
        font-family: ${headingFont};
        font-size: clamp(1.6rem, 4vw, 2.2rem);
        letter-spacing: 0.01em;
      }
      .description {
        margin: 8px 0 0;
        max-width: 620px;
        color: var(--muted);
      }
      .hero__actions {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }
      .hero__tag {
        padding: 6px 12px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: #fff;
        font-size: 0.78rem;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .hero__btn {
        padding: 8px 14px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: transparent;
        color: var(--text);
        font-size: 0.82rem;
        cursor: pointer;
        transition: border-color 0.2s ease;
      }
      .hero__btn:hover {
        border-color: var(--text);
      }
      .mantra {
        margin: 0 0 28px;
        padding: 14px 18px;
        border-radius: 12px;
        background: #ffffff;
        border: 1px solid var(--soft);
        color: var(--muted);
        font-style: italic;
      }
      .sections {
        display: grid;
        grid-template-columns: ${columns};
        gap: 18px;
      }
      .card {
        background: #ffffff;
        border: 1px solid var(--soft);
        border-radius: 16px;
        padding: 20px 22px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .card__head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 12px;
      }
      .card__head h2 {
        margin: 0;
        font-size: 1rem;
        letter-spacing: 0.02em;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid var(--line);
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      .pill--subtle { background: rgba(15, 23, 42, 0.04); }
      .pill--outline { border-style: dashed; }
      .list,
      .questions {
        margin: 0;
        padding: 0;
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .list li,
      .questions li {
        line-height: 1.5;
      }
      .list--dense li { line-height: 1.4; }
      .steps {
        margin: 0;
        padding: 0;
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .steps li {
        display: flex;
        gap: 12px;
        align-items: baseline;
      }
      .steps strong {
        font-size: 0.8rem;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      .card__note {
        margin: 0;
        color: var(--muted);
        font-size: 0.86rem;
      }
      .tech {
        margin-top: 40px;
        text-align: right;
        font-size: 0.78rem;
        color: var(--muted);
      }
      button { font: inherit; }
      @media (max-width: 720px) {
        a.back { position: static; margin-bottom: 16px; display: inline-block; }
        .wrap { padding: 48px 20px 40px; }
        .hero__meta { flex-direction: column; align-items: flex-start; gap: 8px; }
        .sections { grid-template-columns: minmax(0, 1fr); }
      }
    </style>
  </head>
  <body>
    <a class="back" href="../../../index.html">Voltar</a>
    <div class="wrap">
      <header class="hero">
        <div class="hero__meta">
          <div>
            <div class="eyebrow">Projeto do dia · ${today}</div>
            <h1>${safeTitle}</h1>
          </div>
          <div class="hero__actions">
            <span class="hero__tag">${safeDomain}</span>
            <button class="hero__btn" id="dl-tech">Baixar ficha técnica</button>
          </div>
        </div>
        <p class="description">${safeWhy}</p>
      </header>
      <div class="mantra">${mantra}</div>
      <main class="sections">
        ${modulesHtml}
      </main>
      <div class="tech">Preview diário · ${today} · gerado localmente</div>
    </div>
    <script>
      const featureData = ${featureData};
      ${inlineScripts}
      (function(){
        const btn = document.getElementById('dl-tech');
        if (!btn) return;
        btn.addEventListener('click', () => {
          const lines = [
            '# Ficha Técnica',
            'Título: ${safeTitle}',
            'Domínio: ${safeDomain}',
            'Dia UTC: ${today}',
            '',
            'Resumo:',
            '${safeWhy}',
            '',
            'Features essenciais:'
          ];
          featureData.forEach((feat) => lines.push('- ' + feat));
          const text = lines.join('\n');
          const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'ficha-tecnica-${idea.slug || 'preview'}.txt';
          document.body.appendChild(a);
          a.click();
          requestAnimationFrame(() => {
            URL.revokeObjectURL(url);
            a.remove();
          });
        });
      }());
    </script>
  </body>
</html>`;
}

function generateProceduralPreview(key, idea) {
  const rng = createSeededRng(ideaSeedFromDate(key));
  const theme = createTheme(rng);
  const features = ensureFeatureList(idea.features, rng);
  const layoutSize = Math.min(MODULE_BUILDERS.length, 3 + Math.floor(rng() * 2));
  const builders = pickMany(MODULE_BUILDERS, layoutSize, rng);
  const modules = builders.map((builder) => builder({ key, idea, theme, rng, features }));
  const columns = rng() > 0.55 ? 'repeat(auto-fit, minmax(260px, 1fr))' : 'repeat(2, minmax(0, 1fr))';
  const motto = randomPick(POWER_LINES, rng) || POWER_LINES[0];
  return renderProceduralShell({ key, idea, theme, modules, columns, features, motto });
}

async function ensureDailyPreview2() {
  const key = await todayUtcKey();
  let cache = { lastKey: null };
  try {
    const raw = await readFile(PREVIEW2_CACHE_JSON, 'utf8');
    cache = JSON.parse(raw);
  } catch {}
  if (cache.lastKey === key) return; // já atualizado hoje (UTC)

  let meta = { source: 'local', title: 'Preview Diário' };
  let html = '';
  let proceduralIdea = null;
  try {
    if (USE_GPT_PREVIEW2) {
      const mod = await import('./gpt-provider.mjs');
      const proj = await mod.generateProjectApp(key);
      if (proj && proj.html) {
        html = proj.html;
        meta = { source: 'gpt-app', title: proj.title, subtitle: 'Gerado via GPT' };
        console.log('[preview-2] App completo gerado via GPT.');
      } else {
        const idea = await mod.generateProjectIdea(key);
        proceduralIdea = idea;
        html = generateProceduralPreview(key, idea);
        meta = { source: 'gpt-idea+procedural', title: idea.title, subtitle: idea.domain }; 
        console.log('[preview-2] Fallback: gpt idea + gerador local.');
      }
    }
  } catch (e) {
    console.warn('[preview-2] Falha no GPT, usando gerador local:', e?.message || e);
  }
  if (!html) {
    const fallbackIdea = proceduralIdea || generateIdeaLocally(key);
    proceduralIdea = fallbackIdea;
    html = generateProceduralPreview(key, fallbackIdea);
    meta = { source: 'local-procedural', title: fallbackIdea.title, subtitle: fallbackIdea.domain, template: 'procedural-lab' };
  }

  // Escrita atômica e somente se mudar (evita conflitos de save em editores)
  const htmlChanged = await atomicWriteIfChanged(PREVIEW2_PATH, html, 'utf8');
  const cacheChanged = await atomicWriteIfChanged(
    PREVIEW2_CACHE_JSON,
    JSON.stringify({ lastKey: key, meta }, null, 2),
    'utf8'
  );
  if (htmlChanged || cacheChanged) {
    console.log(`[preview-2] Atualizado (${meta.source}) · ${meta.title}`);
  }
}

function msUntilNextUtcRefresh(minuteOffset = 5) {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, minuteOffset, 0, 0));
  const diff = next.getTime() - now.getTime();
  return diff > 0 ? diff : 60_000;
}

function scheduleDailyPreview2Refresh() {
  const delay = msUntilNextUtcRefresh();
  const minutes = Math.round(delay / 60000);
  console.log(`[preview-2] Próxima verificação diária em ~${minutes} minuto(s).`);
  setTimeout(async () => {
    try {
      await ensureDailyPreview2();
    } catch (err) {
      console.error('[preview-2] Erro durante atualização diária:', err);
    } finally {
      scheduleDailyPreview2Refresh();
    }
  }, delay);
}

if (process.argv.includes('--generate-preview2')) {
  await ensureDailyPreview2();
  process.exit(0);
}

if (USE_PREVIEW2_GENERATION) {
  await ensureDailyPreview2();
  scheduleDailyPreview2Refresh();
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);

    // default to index.html on folders and root
    if (pathname.endsWith('/')) pathname += 'index.html';

    // Alias: permitir paths iniciando com /public/ para conveniência nos HTMLs locais
    if (pathname.startsWith('/public/')) {
      pathname = pathname.replace(/^\/public/, '');
    }

    // Intercepta preview-2 para geração diária on-demand
    if (pathname === '/src/previews/preview-2.html' && USE_PREVIEW2_GENERATION) {
      await ensureDailyPreview2();
    }

    // Serve root index.html (outside of public) as a special case
    if (pathname === '/index.html') {
      const outside = path.resolve(rootDir, '..', 'index.html');
      try {
        const data = await readFile(outside);
        res.writeHead(200, {
          'content-type': contentTypeFor(outside),
          'cache-control': 'no-store'
        });
        res.end(data);
        return;
      } catch {}
    }

    let filePath = safeJoin(rootDir, pathname);
    if (!filePath) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    // If path points to a directory, try to serve its index.html
    try {
      const st = await stat(filePath);
      if (st.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
    } catch {}

    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': contentTypeFor(filePath),
      // dev: avoid caches
      'cache-control': 'no-store'
    });
    res.end(data);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } else {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
      console.error('[dev-server] error:', err);
    }
  }
});

server.listen(PORT, () => {
  console.log(`\nDev server running:`);
  console.log(`  Local:  http://localhost:${PORT}/`);
  console.log(`  Index:  http://localhost:${PORT}/index.html`);
  console.log(`  Previews root:  http://localhost:${PORT}/src/previews/`);
  console.log(`  P1:             http://localhost:${PORT}/src/previews/preview-1.html`);
  console.log(`  P2:             http://localhost:${PORT}/src/previews/preview-2.html`);
  if (USE_PREVIEW2_GENERATION) {
    console.log(`  [preview-2] geração automática: ON (env USE_PREVIEW2_GENERATION=1)`);
    if (USE_GPT_PREVIEW2) {
      console.log(`  [preview-2] provedor GPT: ON (OPENAI_API_KEY detectado)`);
    } else {
      console.log(`  [preview-2] provedor GPT: OFF (usando templates locais)`);
    }
  } else {
    console.log(`  [preview-2] geração automática: OFF (servindo arquivo estático)`);
  }
});
