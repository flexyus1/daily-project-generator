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

function toMicroCopy(sentence, maxWords = 3) {
  if (!sentence) return '';
  return sentence
    .replace(/[.,;:!?]/g, '')
    .split(/\s+/)
    .slice(0, maxWords)
    .join(' ')
    .trim();
}

function weightedPick(list, rng) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const total = list.reduce((sum, item) => sum + (Number(item.weight) || 0), 0);
  if (total <= 0) return list[Math.floor(rng() * list.length)];
  let threshold = rng() * total;
  for (const item of list) {
    threshold -= Number(item.weight) || 0;
    if (threshold <= 0) return item;
  }
  return list[list.length - 1];
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

function hexToRgb(hex) {
  let value = String(hex || '').replace('#', '');
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  const int = Number.parseInt(value, 16);
  if (Number.isNaN(int)) return [0, 0, 0];
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function rgbToXyz([r, g, b]) {
  const transform = (val) => {
    const v = val / 255;
    return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  };
  const rl = transform(r) * 100;
  const gl = transform(g) * 100;
  const bl = transform(b) * 100;

  return [
    rl * 0.4124 + gl * 0.3576 + bl * 0.1805,
    rl * 0.2126 + gl * 0.7152 + bl * 0.0722,
    rl * 0.0193 + gl * 0.1192 + bl * 0.9505
  ];
}

function xyzToLab([x, y, z]) {
  const ref = [95.047, 100.0, 108.883];
  const transform = (value, refValue) => {
    const v = value / refValue;
    return v > 0.008856 ? Math.cbrt(v) : (7.787 * v) + (16 / 116);
  };
  const fx = transform(x, ref[0]);
  const fy = transform(y, ref[1]);
  const fz = transform(z, ref[2]);
  return [
    (116 * fy) - 16,
    500 * (fx - fy),
    200 * (fy - fz)
  ];
}

function colorDeltaE(hexA, hexB) {
  const labA = xyzToLab(rgbToXyz(hexToRgb(hexA)));
  const labB = xyzToLab(rgbToXyz(hexToRgb(hexB)));
  const diff = labA.map((a, idx) => a - labB[idx]);
  return Math.sqrt(diff[0] ** 2 + diff[1] ** 2 + diff[2] ** 2);
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

const BASE_TYPOGRAPHY = {
  body: '"Inter", "Segoe UI", system-ui, sans-serif',
  heading: '"Inter", "Segoe UI", system-ui, sans-serif',
  baseHeadingWeight: 600,
  altHeadingWeight: 700
};

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

const PATTERN_VARIANTS = [
  {
    id: 'grid-soft',
    weight: 1,
    build: (theme) => `linear-gradient(135deg, ${theme.accentSoft} 0%, transparent 45%), linear-gradient(315deg, ${theme.highlightSoft} 0%, transparent 55%)`
  },
  {
    id: 'waves-minor',
    weight: 0.8,
    build: (theme) => `radial-gradient(circle at 20% 20%, ${theme.accentSoft} 0%, transparent 55%), radial-gradient(circle at 80% 12%, ${theme.highlightSoft} 0%, transparent 60%)`
  },
  {
    id: 'mesh-fade',
    weight: 0.9,
    build: (theme) => `linear-gradient(120deg, ${hexToRgba(theme.accent, 0.12)} 0%, transparent 50%), linear-gradient(240deg, ${hexToRgba(theme.highlight, 0.12)} 0%, transparent 55%)`
  }
];

const LAYOUT_VARIANTS = [
  {
    id: 'focus-center',
    weight: 1,
    heroMode: 'gallery',
    featureCount: 3,
    css: `
      body.layout--focus-center .preview-stage__inner {
        grid-template-columns: minmax(0, min(520px, 100%));
        justify-content: center;
      }
      body.layout--focus-center .preview-stage__inner > :not(:first-child) {
        max-width: 220px;
        justify-self: center;
      }
    `
  },
  {
    id: 'sidekick',
    weight: 0.9,
    heroMode: 'split',
    featureCount: 3,
    css: `
      body.layout--sidekick .preview-stage__inner {
        grid-template-columns: minmax(0, 1fr) minmax(0, 0.65fr);
      }
      body.layout--sidekick .preview-stage__inner > :first-child {
        grid-row: span 2;
      }
    `
  },
  {
    id: 'tower',
    weight: 0.85,
    heroMode: 'tower',
    featureCount: 3,
    css: `
      body.layout--tower .preview-stage__inner {
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        align-items: stretch;
      }
    `
  },
  {
    id: 'gallery',
    weight: 0.8,
    heroMode: 'badge',
    featureCount: 3,
    css: `
      body.layout--gallery .preview-stage__inner {
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      }
    `
  },
  {
    id: 'stacked',
    weight: 0.75,
    heroMode: 'stacked',
    featureCount: 3,
    css: `
      body.layout--stacked .preview-stage__inner {
        grid-template-columns: minmax(0, 1fr);
      }
      body.layout--stacked .preview-stage__inner > * {
        width: min(100%, 520px);
        justify-self: center;
      }
    `
  },
  {
    id: 'poster',
    weight: 0.7,
    heroMode: 'poster',
    featureCount: 3,
    css: `
      body.layout--poster .preview-stage__inner {
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      }
      body.layout--poster .mockup {
        border-radius: 32px;
        padding: 32px;
      }
    `
  }
];

function createTheme(rng, { lastVariant } = {}) {
  const lastThemeId = lastVariant?.themeId || null;
  const lastAccent = lastVariant?.accent || null;
  const available = THEME_PRESETS.slice();
  const pool = available.filter((theme) => theme.id !== lastThemeId);
  let preset = weightedPick(pool.length ? pool : available, rng) || available[0];

  const findAccent = (candidate) => {
    const options = candidate.accents.slice();
    for (const opt of options) {
      if (!lastAccent || colorDeltaE(opt, lastAccent) >= 10) return opt;
    }
    return options[0];
  };

  let accent = findAccent(preset);
  if (lastAccent && colorDeltaE(accent, lastAccent) < 10) {
    const altThemes = available.filter((theme) => theme.id !== preset.id && theme.id !== lastThemeId);
    for (const candidate of altThemes) {
      const candidateAccent = findAccent(candidate);
      if (!candidateAccent || (lastAccent && colorDeltaE(candidateAccent, lastAccent) < 10)) continue;
      preset = candidate;
      accent = candidateAccent;
      break;
    }
  }

  const highlightChoices = preset.highlights.filter((c) => c !== accent);
  const highlight = highlightChoices.find((color) => !lastAccent || colorDeltaE(color, accent) >= 6) || highlightChoices[0] || accent;
  const accentSoft = hexToRgba(accent, 0.22);
  const highlightSoft = hexToRgba(highlight, 0.2);
  const layers = (preset.backgroundLayers || []).map((layer) => {
    const color = layer.color === 'highlight' ? highlightSoft : accentSoft;
    return `${layer.shape}-gradient(${layer.size} at ${layer.position}, ${color}, transparent ${layer.stop})`;
  });
  const background = `${layers.join(', ')}, ${preset.base}`;
  const font = weightedPick(FONT_STACKS, rng) || FONT_STACKS[0];
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

function ensureFeatureList(features, rng, desiredCount = 3) {
  const target = Math.max(1, desiredCount);
  const base = Array.isArray(features) ? features.filter(Boolean) : [];
  const pool = Array.from(new Set([...TRAINING_RITUALS, ...FOCUS_POINTS, ...DAILY_PROMPTS]));
  while (base.length < target) {
    const candidate = randomPick(pool, rng);
    if (candidate && !base.includes(candidate)) base.push(candidate);
  }
  return base.slice(0, target);
}


function ensureRgba(color, alpha = 1) {
  if (!color) return `rgba(255, 255, 255, ${alpha})`;
  if (color.startsWith('#')) {
    return hexToRgba(color, alpha);
  }
  const match = color.match(/rgba?\(([^)]+)\)/i);
  if (!match) {
    return color;
  }
  const parts = match[1].split(',').map((value) => Number.parseFloat(value.trim()));
  if (parts.length < 3) {
    return color;
  }
  const [r, g, b] = parts;
  const resolvedAlpha = Number.isFinite(alpha) ? alpha : parts[3] ?? 1;
  return `rgba(${Math.max(0, Math.min(255, r))}, ${Math.max(0, Math.min(255, g))}, ${Math.max(0, Math.min(255, b))}, ${Math.max(0, Math.min(1, resolvedAlpha))})`;
}

function buildPaletteBlock(theme, rng, { count = 4 } = {}) {
  const swatches = [
    theme.accent,
    theme.highlight,
    theme.accentSoft,
    theme.highlightSoft,
    theme.panel,
    theme.surfaceSoft
  ].filter(Boolean);
  const palette = Array.from(new Set(swatches));
  if (!palette.length) {
    return '';
  }
  const desired = Math.min(count, palette.length);
  const selected = pickMany(palette, desired, rng);
  const items = selected
    .map((color, index) => `<span style="--swatch-color:${ensureRgba(color, 1)}; --swatch-index:${index};"></span>`)
    .join('');
  return `<div class="mockup-mini mockup-mini--palette" aria-hidden="true">${items}</div>`;
}

function buildMiniStatCard(label, value, fillPercent, opts = {}) {
  const safeLabel = escapeHtml(label || '');
  const safeValue = escapeHtml(value || '');
  const fill = Math.max(0, Math.min(100, Math.round(fillPercent ?? 0)));
  const tone = opts.tone === 'highlight' ? 'highlight' : 'accent';
  return `<div class="mockup-mini mockup-mini--stat mockup-mini--${tone}" aria-hidden="true">
    <span class="mockup-mini__label">${safeLabel}</span>
    <span class="mockup-mini__value">${safeValue}</span>
    <span class="mockup-mini__bar"><span style="--fill:${fill};"></span></span>
  </div>`;
}

function buildTimerMockup(ctx) {
  const { rng, theme } = ctx;
  const minutes = String(Math.floor(rng() * 35) + 5).padStart(2, '0');
  const seconds = String(Math.floor(rng() * 60)).padStart(2, '0');
  const progress = Math.round(rng() * 60 + 20);
  const cycle = Math.max(1, Math.min(8, Math.round(progress / 10)));
  const segments = Array.from({ length: 4 }, (_, idx) => {
    const fill = Math.round(40 + rng() * 50);
    return `<li style="--fill:${fill};"><span>${String(idx + 1).padStart(2, '0')}</span></li>`;
  }).join('');
  const html = `
    <section class="mockup mockup--timer" aria-label="Prévia de cronômetro minimalista">
      <header class="mockup__chrome">
        <div class="mockup__leds" aria-hidden="true"><span></span><span></span><span></span></div>
        <span class="mockup__tag">Focus</span>
      </header>
      <div class="mockup__dial" role="img" aria-label="Tempo restante ${minutes} minutos e ${seconds} segundos">
        <div class="mockup__ring" style="--progress:${progress};"></div>
        <span class="mockup__time">${minutes}:${seconds}</span>
        <span class="mockup__sub">${String(cycle).padStart(2, '0')}º ciclo</span>
      </div>
      <div class="mockup__controls" role="group" aria-label="Controles do cronômetro">
        <button class="mockup__btn mockup__btn--primary" type="button">▸</button>
        <button class="mockup__btn" type="button">❚❚</button>
        <button class="mockup__btn" type="button">↻</button>
      </div>
      <ul class="mockup__segments">
        ${segments}
      </ul>
    </section>
    ${buildMiniStatCard('Sessões', String(cycle).padStart(2, '0') + '/08', progress + 10, { tone: 'highlight' })}
    ${buildPaletteBlock(theme, rng)}
  `;
  const css = `
    .mockup--timer .mockup__dial {
      display: grid;
      place-items: center;
      gap: 12px;
    }
    .mockup--timer .mockup__ring {
      position: relative;
      width: min(240px, 70vw);
      aspect-ratio: 1;
      border-radius: 50%;
      background:
        radial-gradient(circle at center, color-mix(in srgb, var(--surface) 94%, transparent) 52%, transparent 53%),
        conic-gradient(var(--accent) calc(var(--progress) * 1%), color-mix(in srgb, var(--accent-soft) 60%, transparent) 0);
      display: grid;
      place-items: center;
      box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent) 24%, transparent);
      isolation: isolate;
    }
    .mockup--timer .mockup__time {
      font-size: clamp(3rem, 9vw, 4.2rem);
      font-weight: 600;
      letter-spacing: 0.08em;
    }
    .mockup--timer .mockup__sub {
      font-size: 0.78rem;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .mockup--timer .mockup__controls {
      display: flex;
      justify-content: center;
      gap: 12px;
    }
    .mockup--timer .mockup__btn {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: 1px solid color-mix(in srgb, var(--border) 65%, transparent);
      background: color-mix(in srgb, var(--surface) 92%, transparent);
      font-size: 1.2rem;
      color: var(--text);
    }
    .mockup--timer .mockup__btn--primary {
      background: color-mix(in srgb, var(--accent) 62%, var(--surface) 38%);
      color: white;
      border-color: transparent;
      box-shadow: 0 18px 32px color-mix(in srgb, var(--accent) 22%, transparent);
    }
    .mockup--timer .mockup__segments {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      padding: 0;
      margin: 0;
      list-style: none;
    }
    .mockup--timer .mockup__segments li {
      position: relative;
      padding: 12px;
      border-radius: 16px;
      background: color-mix(in srgb, var(--surface-soft) 90%, transparent);
      border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
      display: grid;
      place-items: center;
      font-size: 0.82rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .mockup--timer .mockup__segments li::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 38%, transparent) calc(var(--fill) * 1%), transparent 0);
      opacity: 0.6;
      mix-blend-mode: multiply;
    }
  `;
  const parts = ['cronometro-digital', 'controle-de-sessoes', 'paleta'];
  return { id: 'timer', signature: `timer-${progress}-${cycle}`, html: html.trim(), css: css.trim(), parts };
}

function buildHabitMockup(ctx) {
  const { rng, theme } = ctx;
  const days = ['S', 'T', 'Q', 'Q', 'S', 'S', 'D'];
  const weeks = 4;
  const paletteKey = [];
  const cells = [];
  for (let row = 0; row < weeks; row += 1) {
    for (let col = 0; col < days.length; col += 1) {
      const intensity = rng();
      const key = intensity > 0.64 ? 'S' : intensity > 0.3 ? 'M' : 'O';
      const classes = key === 'S' ? 'is-strong' : key === 'M' ? 'is-mid' : 'is-off';
      paletteKey.push(key);
      cells.push(`<span class="mockup__cell ${classes}" aria-hidden="true"></span>`);
    }
  }
  const streak = Math.max(3, Math.floor(rng() * 14) + 3);
  const target = streak + Math.max(2, Math.floor(rng() * 5));
  const html = `
    <section class="mockup mockup--grid" aria-label="Prévia de rastreador de hábitos">
      <header class="mockup__chrome">
        <div class="mockup__leds" aria-hidden="true"><span></span><span></span><span></span></div>
        <span class="mockup__tag">Hábitos</span>
      </header>
      <div class="mockup__matrix">
        <div class="mockup__matrix-head">
          ${days.map((day) => `<span>${day}</span>`).join('')}
        </div>
        <div class="mockup__matrix-body" role="presentation">
          ${cells.join('')}
        </div>
      </div>
      <footer class="mockup__footer">
        <span class="mockup__chip">Streak ${String(streak).padStart(2, '0')}d</span>
        <span class="mockup__chip mockup__chip--ghost">Meta ${String(target).padStart(2, '0')}d</span>
      </footer>
    </section>
    ${buildMiniStatCard('Concluídos', String(streak).padStart(2, '0'), (streak / target) * 100)}
    ${buildPaletteBlock(theme, rng)}
  `;
  const css = `
    .mockup--grid .mockup__matrix {
      display: grid;
      gap: 12px;
    }
    .mockup--grid .mockup__matrix-head {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 8px;
      font-size: 0.72rem;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .mockup--grid .mockup__matrix-body {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 8px;
    }
    .mockup--grid .mockup__cell {
      width: 100%;
      aspect-ratio: 1;
      border-radius: 10px;
      background: color-mix(in srgb, var(--surface-soft) 90%, transparent);
      border: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--border) 20%, transparent);
    }
    .mockup--grid .mockup__cell.is-mid {
      background: color-mix(in srgb, var(--accent-soft) 60%, transparent);
      border-color: color-mix(in srgb, var(--accent) 30%, transparent);
    }
    .mockup--grid .mockup__cell.is-strong {
      background: color-mix(in srgb, var(--accent) 55%, transparent);
      border-color: transparent;
      box-shadow: 0 12px 22px color-mix(in srgb, var(--accent) 16%, transparent);
    }
    .mockup--grid .mockup__footer {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .mockup--grid .mockup__chip {
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 0.72rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      background: color-mix(in srgb, var(--accent-soft) 70%, var(--surface) 30%);
      color: var(--text);
    }
    .mockup--grid .mockup__chip--ghost {
      background: color-mix(in srgb, var(--surface-soft) 90%, transparent);
      border: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
    }
  `;
  const parts = ['grade-de-habitos', 'streak', 'paleta'];
  const signature = `habit-${streak}-${target}-${paletteKey.slice(0, 6).join('')}`;
  return { id: 'habit', signature, html: html.trim(), css: css.trim(), parts };
}

function buildListMockup(ctx) {
  const { rng, theme, idea } = ctx;
  const labelsPool = ['UI', 'API', 'QA', 'DEV', 'OPS', 'DOC', 'QA+', 'UX'];
  const labels = [];
  const fills = [];
  const rows = [];
  const count = 5;
  for (let index = 0; index < count; index += 1) {
    const label = randomPick(labelsPool, rng) || labelsPool[index % labelsPool.length];
    const fill = Math.round(30 + rng() * 60);
    const state = rng();
    const stateClass = state > 0.66 ? 'is-complete' : state > 0.3 ? 'is-progress' : 'is-idle';
    labels.push(label);
    fills.push(fill);
    rows.push(`<li class="mockup__row ${stateClass}">
      <span class="mockup__badge">${String(index + 1).padStart(2, '0')}</span>
      <div class="mockup__track"><span style="--fill:${fill};"></span></div>
      <span class="mockup__label">${escapeHtml(label)}</span>
    </li>`);
  }
  const headerTag = (idea?.slug || '').includes('deploy') ? 'Deploy' : 'Prioridades';
  const html = `
    <section class="mockup mockup--list" aria-label="Prévia de lista de atividades">
      <header class="mockup__chrome">
        <div class="mockup__leds" aria-hidden="true"><span></span><span></span><span></span></div>
        <span class="mockup__tag">${escapeHtml(headerTag)}</span>
      </header>
      <ul class="mockup__rows">
        ${rows.join('')}
      </ul>
    </section>
    ${buildMiniStatCard('Ativos', '#' + String(Math.floor(rng() * 9) + 3).padStart(2, '0'), 72)}
    ${buildPaletteBlock(theme, rng)}
  `;
  const css = `
    .mockup--list .mockup__rows {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .mockup--list .mockup__row {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border-radius: 16px;
      background: color-mix(in srgb, var(--surface-soft) 85%, transparent);
      border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
    }
    .mockup--list .mockup__row.is-complete {
      background: color-mix(in srgb, var(--highlight-soft) 70%, transparent);
      border-color: color-mix(in srgb, var(--highlight) 30%, transparent);
    }
    .mockup--list .mockup__row.is-progress {
      border-color: color-mix(in srgb, var(--accent) 35%, transparent);
    }
    .mockup--list .mockup__badge {
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      border-radius: 12px;
      font-size: 0.75rem;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      border: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
      background: color-mix(in srgb, var(--surface) 92%, transparent);
    }
    .mockup--list .mockup__track {
      position: relative;
      height: 8px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--surface-soft) 90%, transparent);
      overflow: hidden;
    }
    .mockup--list .mockup__track span {
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--highlight) 60%, transparent));
      width: calc(var(--fill) * 1%);
    }
    .mockup--list .mockup__label {
      font-size: 0.82rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--muted);
    }
  `;
  const signature = `list-${headerTag}-${labels.slice(0, 2).join('-')}-${fills.slice(0, 2).join('-')}`;
  const parts = ['lista-visual', 'progressos', 'paleta'];
  return { id: 'list', signature, html: html.trim(), css: css.trim(), parts };
}

function buildBudgetMockup(ctx) {
  const { rng, theme } = ctx;
  const items = ['Fixos', 'Flex', 'Meta', 'Saldo'];
  const barEntries = [];
  const fillKeys = [];
  for (const label of items) {
    const fill = Math.min(100, Math.round(35 + rng() * 55));
    const value = Math.round(800 + rng() * 2200);
    const formatted = value.toLocaleString('pt-BR');
    fillKeys.push(fill);
    barEntries.push(`<li>
      <span class="mockup__bar-label">${label}</span>
      <span class="mockup__bar-track"><span style="--fill:${fill};"></span></span>
      <span class="mockup__bar-value">R$ ${formatted}</span>
    </li>`);
  }
  const pieSlice = Math.round(28 + rng() * 52);
  const amount = (5400 + pieSlice * 26).toLocaleString('pt-BR');
  const html = `
    <section class="mockup mockup--budget" aria-label="Prévia de painel financeiro minimalista">
      <header class="mockup__chrome">
        <div class="mockup__leds" aria-hidden="true"><span></span><span></span><span></span></div>
        <span class="mockup__tag">Budget</span>
      </header>
      <div class="mockup__chart">
        <div class="mockup__pie" style="--slice:${pieSlice};"></div>
        <div class="mockup__summary">
          <span class="mockup__amount">R$ ${amount}</span>
          <span class="mockup__hint">Saldo projetado</span>
        </div>
      </div>
      <ul class="mockup__bars">
        ${barEntries.join('')}
      </ul>
    </section>
    ${buildMiniStatCard('Limite', '82%', pieSlice + 20, { tone: 'highlight' })}
    ${buildPaletteBlock(theme, rng)}
  `;
  const css = `
    .mockup--budget .mockup__chart {
      display: grid;
      grid-template-columns: minmax(0, 160px) minmax(0, 1fr);
      gap: 20px;
      align-items: center;
    }
    .mockup--budget .mockup__pie {
      position: relative;
      width: 100%;
      aspect-ratio: 1;
      border-radius: 50%;
      background:
        conic-gradient(var(--accent) calc(var(--slice) * 1%), color-mix(in srgb, var(--highlight-soft) 80%, transparent) 0);
      box-shadow: 0 24px 40px color-mix(in srgb, var(--accent) 20%, transparent);
    }
    .mockup--budget .mockup__pie::after {
      content: '';
      position: absolute;
      inset: 20%;
      border-radius: 50%;
      background: color-mix(in srgb, var(--surface) 96%, transparent);
    }
    .mockup--budget .mockup__summary {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .mockup--budget .mockup__amount {
      font-size: clamp(1.4rem, 4vw, 1.8rem);
      font-weight: 600;
      letter-spacing: 0.04em;
    }
    .mockup--budget .mockup__hint {
      font-size: 0.78rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .mockup--budget .mockup__bars {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .mockup--budget .mockup__bars li {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 12px;
      align-items: center;
    }
    .mockup--budget .mockup__bar-track {
      position: relative;
      height: 8px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--surface-soft) 85%, transparent);
      overflow: hidden;
    }
    .mockup--budget .mockup__bar-track span {
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--accent), var(--highlight));
      width: calc(var(--fill) * 1%);
    }
    .mockup--budget .mockup__bar-label {
      font-size: 0.82rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .mockup--budget .mockup__bar-value {
      font-size: 0.88rem;
      font-weight: 500;
      color: var(--text);
    }
  `;
  const parts = ['grafico-pizza', 'barras-progresso', 'paleta'];
  const signature = `budget-${pieSlice}-${fillKeys.slice(0, 2).join('-')}`;
  return { id: 'budget', signature, html: html.trim(), css: css.trim(), parts };
}

function buildFlashcardMockup(ctx) {
  const { rng, theme } = ctx;
  const words = ['git push', 'grep', 'chmod', 'alias', 'curl', 'npm run', 'ssh'];
  const hints = ['modo nano', 'flag -r', 'pipe', 'stdin', 'hotkey'];
  const activeWord = escapeHtml(randomPick(words, rng) || words[0]);
  const hintWord = escapeHtml(randomPick(hints, rng) || hints[0]);
  const html = `
    <section class="mockup mockup--cards" aria-label="Prévia de flashcards interativos">
      <header class="mockup__chrome">
        <div class="mockup__leds" aria-hidden="true"><span></span><span></span><span></span></div>
        <span class="mockup__tag">Flash</span>
      </header>
      <div class="mockup__deck">
        <span class="mockup__card mockup__card--ghost"></span>
        <span class="mockup__card mockup__card--secondary"></span>
        <span class="mockup__card mockup__card--primary">
          <span class="mockup__card-label">${activeWord}</span>
          <span class="mockup__card-hint">${hintWord}</span>
        </span>
      </div>
      <footer class="mockup__footer">
        <span class="mockup__chip">Flip ⟲</span>
        <span class="mockup__chip mockup__chip--ghost">Modo treino</span>
      </footer>
    </section>
    ${buildMiniStatCard('Dominadas', String(Math.floor(rng() * 20) + 12), 68)}
    ${buildPaletteBlock(theme, rng)}
  `;
  const css = `
    .mockup--cards .mockup__deck {
      position: relative;
      display: grid;
      place-items: center;
      min-height: 240px;
    }
    .mockup--cards .mockup__card {
      position: absolute;
      width: min(260px, 80%);
      aspect-ratio: 3 / 4;
      border-radius: 22px;
      box-shadow: 0 28px 68px rgba(15, 23, 42, 0.18);
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      gap: 12px;
      text-transform: uppercase;
      letter-spacing: 0.16em;
    }
    .mockup--cards .mockup__card--ghost {
      transform: translate(26px, -26px);
      background: color-mix(in srgb, var(--surface-soft) 90%, transparent);
      border: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
    }
    .mockup--cards .mockup__card--secondary {
      transform: translate(12px, -12px);
      background: color-mix(in srgb, var(--accent-soft) 70%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
    }
    .mockup--cards .mockup__card--primary {
      position: relative;
      background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--highlight) 60%, transparent));
      color: white;
    }
    .mockup--cards .mockup__card-label {
      font-size: clamp(1.2rem, 5vw, 1.6rem);
      font-weight: 600;
    }
    .mockup--cards .mockup__card-hint {
      font-size: 0.75rem;
      letter-spacing: 0.18em;
      opacity: 0.8;
    }
    .mockup--cards .mockup__footer {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
  `;
  const parts = ['deck-de-cartas', 'contagem', 'paleta'];
  const signature = `flash-${activeWord}-${hintWord}`;
  return { id: 'flashcards', signature, html: html.trim(), css: css.trim(), parts };
}

function buildDocumentMockup(ctx) {
  const { rng, theme } = ctx;
  const headWidths = [];
  const headLines = [];
  for (let i = 0; i < 5; i += 1) {
    const width = Math.round(40 + rng() * 50);
    headWidths.push(width);
    headLines.push(`<span class="mockup__line" style="--width:${width};"></span>`);
  }
  const blockWidths = [];
  const blocks = [];
  for (let block = 0; block < 3; block += 1) {
    const lines = [];
    for (let line = 0; line < 4; line += 1) {
      const width = Math.round(30 + rng() * 60);
      blockWidths.push(width);
      lines.push(`<span class="mockup__line" style="--width:${width};"></span>`);
    }
    blocks.push(`<div class="mockup__block">${lines.join('')}</div>`);
  }
  const html = `
    <section class="mockup mockup--document" aria-label="Prévia de documento README">
      <header class="mockup__chrome">
        <div class="mockup__leds" aria-hidden="true"><span></span><span></span><span></span></div>
        <span class="mockup__tag">README</span>
      </header>
      <div class="mockup__doc">
        <div class="mockup__hero">
          <span class="mockup__title">Projeto</span>
          <span class="mockup__subtitle">Visão rápida</span>
        </div>
        <div class="mockup__content">
          ${headLines.join('')}
          ${blocks.join('')}
        </div>
      </div>
    </section>
    ${buildMiniStatCard('Seções', '05', 60, { tone: 'highlight' })}
    ${buildPaletteBlock(theme, rng)}
  `;
  const css = `
    .mockup--document .mockup__doc {
      display: grid;
      gap: 18px;
    }
    .mockup--document .mockup__hero {
      display: grid;
      gap: 4px;
      padding-bottom: 12px;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
    }
    .mockup--document .mockup__title {
      font-size: clamp(1.5rem, 5vw, 1.9rem);
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .mockup--document .mockup__subtitle {
      font-size: 0.82rem;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .mockup--document .mockup__content {
      display: grid;
      gap: 14px;
    }
    .mockup--document .mockup__line {
      height: 8px;
      border-radius: 6px;
      width: calc(var(--width) * 1%);
      background: color-mix(in srgb, var(--surface-soft) 88%, transparent);
      border: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
    }
    .mockup--document .mockup__block {
      display: grid;
      gap: 8px;
      padding: 12px;
      border-radius: 16px;
      background: color-mix(in srgb, var(--accent-soft) 70%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    }
  `;
  const parts = ['documento', 'resumo-visual', 'paleta'];
  const signature = `document-${headWidths.slice(0, 3).join('-')}-${blockWidths.slice(0, 2).join('-')}`;
  return { id: 'document', signature, html: html.trim(), css: css.trim(), parts };
}

function buildDefaultMockup(ctx) {
  return buildListMockup(ctx);
}

const APP_MOCKUPS = [
  { id: 'timer', match: ['timer', 'pomodoro', 'cronometro'], build: buildTimerMockup },
  { id: 'habit', match: ['habit', 'hábito', 'habito', 'streak'], build: buildHabitMockup },
  { id: 'budget', match: ['budget', 'orcamento', 'orçamento', 'finance'], build: buildBudgetMockup },
  { id: 'flashcards', match: ['flashcard', 'card'], build: buildFlashcardMockup },
  { id: 'document', match: ['readme', 'document', 'doc'], build: buildDocumentMockup },
  { id: 'list', match: ['todo', 'tarefas', 'task', 'checklist', 'deploy'], build: buildListMockup }
];

function buildAppMockup(ctx) {
  const slugText = `${ctx.idea?.slug || ''} ${ctx.idea?.title || ''}`.toLowerCase();
  const entry = APP_MOCKUPS.find((item) => item.match.some((token) => slugText.includes(token)));
  const builder = entry?.build || buildDefaultMockup;
  const payload = builder(ctx) || buildDefaultMockup(ctx);
  const id = payload.id || entry?.id || 'list';
  const signature = payload.signature || id;
  return {
    id,
    signature,
    html: (payload.html || '').trim(),
    css: (payload.css || '').trim(),
    parts: Array.isArray(payload.parts) ? payload.parts : [],
    script: payload.script || ''
  };
}

function buildVariantSignature(themeId, layoutId, patternId, mockupKey) {
  return `${themeId}|${layoutId}|${patternId}|${mockupKey}`;
}

function selectLayoutVariant(rng, { lastVariant, avoidId } = {}) {
  const pool = LAYOUT_VARIANTS.slice();
  const filtered = pool.filter((variant) => variant.id !== avoidId && (!lastVariant || variant.id !== lastVariant.layoutId));
  return weightedPick(filtered.length ? filtered : pool, rng) || pool[0];
}

function selectPatternVariant(rng, { lastVariant, avoidId, theme }) {
  const pool = PATTERN_VARIANTS.slice();
  const filtered = pool.filter((variant) => variant.id !== avoidId && (!lastVariant || variant.id !== lastVariant.patternId));
  const chosen = weightedPick(filtered.length ? filtered : pool, rng) || pool[0];
  return {
    id: chosen.id,
    css: chosen.build(theme)
  };
}


function renderProceduralShell({ key, idea, theme, features, motto, patternCss, profile, typography, layoutId, heroMode, layoutCss, mockup }) {
  const safeTitle = escapeHtml(idea.title || 'Projeto do Dia');
  const safeDomain = escapeHtml(idea.domain || 'Domínio');
  const safeWhy = escapeHtml(idea.why || 'Plano diário para evoluir decisões de draft.');
  const mockupHtml = (mockup?.html || '').trim();
  const mockupScript = typeof mockup?.script === 'string' ? mockup.script.trim() : '';
  const featureData = JSON.stringify(features);
  const mantra = escapeHtml(motto || '');
  const today = escapeHtml(key);
  const headingFont = typography.heading || typography.body || 'system-ui, sans-serif';
  const bodyFont = typography.body || 'system-ui, sans-serif';
  const inlineScripts = mockupScript ? `${mockupScript}
` : '';
  const patternLayer = patternCss ? `${patternCss}, ${theme.background}` : theme.background;
  const profileData = JSON.stringify(profile);
  const safeLayoutId = (layoutId || 'focus-center').replace(/[^a-z0-9-]/gi, '') || 'focus-center';
  const safeHeroMode = (heroMode || 'gallery').replace(/[^a-z0-9-]/gi, '') || 'gallery';
  const layoutClass = `layout layout--${safeLayoutId} hero--${safeHeroMode}`;
  const layoutCssBlock = layoutCss ? String(layoutCss) : '';
  const mockupCssBlock = mockup?.css ? String(mockup.css) : '';
  const stageHtml = mockupHtml || '<section class="mockup mockup--empty" aria-label="Prévia indisponível"><div class="mockup__chrome"><div class="mockup__leds" aria-hidden="true"><span></span><span></span><span></span></div><span class="mockup__tag">Preview</span></div><div class="mockup__empty-state">Visual em preparação</div></section>';
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      :root {
        --base: ${theme.base};
        --surface: ${theme.surface};
        --panel: ${theme.panel};
        --surface-soft: ${theme.surfaceSoft};
        --text: ${theme.text};
        --muted: ${theme.muted};
        --border: ${theme.border};
        --accent: ${theme.accent};
        --accent-soft: ${theme.accentSoft};
        --accent-strong: ${theme.accentStrong};
        --highlight: ${theme.highlight};
        --highlight-soft: ${theme.highlightSoft};
        --shadow: ${theme.shadow};
        --heading-weight: ${typography.headingWeight || typography.baseHeadingWeight || 600};
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: ${patternLayer};
        color: var(--text);
        font: 15px/1.6 ${bodyFont};
        padding-bottom: 60px;
      }
      a.back {
        position: fixed;
        top: 24px;
        left: 24px;
        text-decoration: none;
        color: var(--muted);
        font-size: 0.8rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        z-index: 2;
        transition: color 0.2s ease;
      }
      a.back::before { content: '← '; }
      a.back:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
      a.back:hover { color: var(--text); }
      .wrap {
        max-width: 960px;
        margin: 0 auto;
        padding: 96px 32px 32px;
        display: flex;
        flex-direction: column;
        gap: 36px;
      }
      .hero {
        display: flex;
        flex-direction: column;
        gap: 28px;
      }
      .hero__meta {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 20px;
        flex-wrap: wrap;
      }
      .hero__info {
        display: flex;
        flex-direction: column;
        gap: 8px;
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
        font-size: clamp(1.8rem, 4vw, 2.6rem);
        letter-spacing: 0.01em;
        font-weight: var(--heading-weight);
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
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--surface-soft) 90%, transparent);
        font-size: 0.78rem;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .hero__btn {
        padding: 8px 16px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
        background: color-mix(in srgb, var(--panel) 85%, transparent);
        color: var(--text);
        font-size: 0.82rem;
        cursor: pointer;
        transition: transform 0.2s ease, border-color 0.2s ease;
      }
      .hero__btn:hover {
        border-color: var(--accent);
        transform: translateY(-3px);
      }
      .hero__btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 4px;
      }
      .hero__visual {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 32px;
      }
      .hero__canvas {
        position: relative;
        width: clamp(180px, 28vw, 240px);
        aspect-ratio: 1;
        border-radius: 36%;
        background: var(--accent-soft);
        overflow: hidden;
        filter: drop-shadow(0 20px 40px rgba(15, 23, 42, 0.14));
      }
      .hero__shape {
        position: absolute;
        border-radius: 999px;
        filter: blur(0px);
        opacity: 0.75;
      }
      .hero__shape--one {
        inset: 18% 32% 34% 18%;
        background: linear-gradient(135deg, var(--accent), transparent);
      }
      .hero__shape--two {
        inset: 36% 18% 18% 36%;
        background: linear-gradient(160deg, var(--highlight), transparent);
        opacity: 0.62;
      }
      .hero__shape--three {
        inset: 12% 58% 48% -12%;
        background: linear-gradient(220deg, var(--accent-strong), transparent);
        opacity: 0.48;
      }
      .hero__summary {
        display: flex;
        flex-direction: column;
        gap: 12px;
        align-items: flex-end;
      }
      .hero__chip {
        display: inline-flex;
        align-items: center;
        padding: 10px 18px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
        background: color-mix(in srgb, var(--surface) 88%, var(--panel) 12%);
        font-size: 0.84rem;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .hero__chip--accent {
        background: color-mix(in srgb, var(--accent-soft) 70%, var(--surface) 30%);
        border-color: transparent;
        color: var(--text);
        box-shadow: 0 22px 42px rgba(15, 23, 42, 0.18);
      }
      .preview-stage {
        display: flex;
        justify-content: center;
      }
      .preview-stage__inner {
        width: 100%;
        display: grid;
        gap: 28px;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        align-items: center;
      }
      .mockup {
        position: relative;
        border-radius: 28px;
        padding: 28px;
        background: color-mix(in srgb, var(--surface) 94%, var(--panel) 6%);
        border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
        box-shadow: 0 32px 60px rgba(15, 23, 42, 0.16);
        display: flex;
        flex-direction: column;
        gap: 24px;
        overflow: hidden;
      }
      .mockup__chrome {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      .mockup__leds {
        display: inline-flex;
        gap: 6px;
      }
      .mockup__leds span {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: color-mix(in srgb, var(--surface-soft) 80%, transparent);
        border: 1px solid color-mix(in srgb, var(--border) 45%, transparent);
      }
      .mockup__tag {
        padding: 8px 14px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
        font-size: 0.74rem;
        letter-spacing: 0.16em;
        text-transform: uppercase;
      }
      .mockup__footer {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }
      .mockup__chip {
        padding: 6px 12px;
        border-radius: 999px;
        font-size: 0.72rem;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        background: color-mix(in srgb, var(--surface-soft) 88%, transparent);
        border: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
      }
      .mockup__chip--ghost {
        border-style: dashed;
        color: var(--muted);
      }
      .mockup__empty-state {
        width: 100%;
        padding: 28px;
        border: 1px dashed color-mix(in srgb, var(--border) 60%, transparent);
        border-radius: 18px;
        font-size: 0.9rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .mockup-mini {
        position: relative;
        padding: 18px;
        border-radius: 18px;
        background: color-mix(in srgb, var(--surface-soft) 88%, transparent);
        border: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
        display: grid;
        gap: 10px;
        align-content: start;
        min-height: 120px;
      }
      .mockup-mini--palette {
        display: inline-grid;
        grid-template-columns: repeat(auto-fit, minmax(36px, 1fr));
        gap: 10px;
      }
      .mockup-mini--palette span {
        width: 100%;
        aspect-ratio: 1;
        border-radius: 14px;
        background: var(--swatch-color);
        box-shadow: inset 0 -6px 12px rgba(15, 23, 42, 0.12);
      }
      .mockup-mini--stat {
        background: color-mix(in srgb, var(--surface) 92%, transparent);
      }
      .mockup-mini--stat.mockup-mini--accent {
        background: color-mix(in srgb, var(--accent-soft) 60%, transparent);
        border-color: color-mix(in srgb, var(--accent) 35%, transparent);
      }
      .mockup-mini--stat.mockup-mini--highlight {
        background: color-mix(in srgb, var(--highlight-soft) 70%, transparent);
        border-color: color-mix(in srgb, var(--highlight) 30%, transparent);
      }
      .mockup-mini__label {
        font-size: 0.72rem;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .mockup-mini__value {
        font-size: 1.6rem;
        font-weight: 600;
      }
      .mockup-mini__bar {
        position: relative;
        height: 6px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--surface-soft) 88%, transparent);
        overflow: hidden;
      }
      .mockup-mini__bar span {
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: linear-gradient(90deg, var(--accent), var(--highlight));
        width: calc(var(--fill) * 1%);
      }
      .preview-stage__inner > .mockup-mini {
        align-self: stretch;
      }
      .pin-panel {
        position: relative;
        padding: 22px;
        border-radius: 18px;
        background: color-mix(in srgb, var(--surface-soft) 88%, transparent);
        border: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .pin-panel.is-visible {
        box-shadow: 0 22px 48px rgba(15, 23, 42, 0.12);
      }
      .pin-panel__title {
        margin: 0;
        font-size: 0.92rem;
        font-weight: 600;
      }
      .pin-panel__note {
        margin: 0;
        font-size: 0.8rem;
        color: var(--muted);
      }
      .weight-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .weight-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        font-size: 0.8rem;
        color: var(--muted);
      }
      .weight-item input { flex: 1; }
      .pin-panel__permalink {
        padding: 6px 10px;
        border-radius: 8px;
        background: color-mix(in srgb, var(--surface-soft) 85%, transparent);
        border: 1px dashed var(--border);
        font-size: 0.78rem;
        word-break: break-all;
      }
      .pin-panel__actions {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }
      .pin-panel__actions button {
        padding: 8px 14px;
        border-radius: 10px;
        border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
        background: color-mix(in srgb, var(--panel) 85%, transparent);
        color: var(--text);
        cursor: pointer;
        transition: border-color 0.2s ease;
      }
      .pin-panel__actions button:hover { border-color: var(--accent); }
      button { font: inherit; }
      ${mockupCssBlock}
      ${layoutCssBlock}
      @media (max-width: 720px) {
        a.back { position: static; margin: 24px 0 0; display: inline-block; }
        .wrap { padding: 72px 20px 32px; }
        .hero { padding: 0; }
        .hero.hero--split,
        .hero.hero--tower,
        .hero.hero--badge,
        .hero.hero--poster {
          display: flex;
          flex-direction: column;
          gap: 24px;
        }
        .hero.hero--poster { padding: 24px; }
        .hero__visual { grid-template-columns: minmax(0, 1fr); gap: 18px; }
        .hero__summary { align-items: flex-start; }
        .preview-stage__inner { grid-template-columns: minmax(0, 1fr); }
      }
      @media (prefers-reduced-motion: reduce) {
        * { scroll-behavior: auto !important; }
        .hero__btn,
        .mockup,
        .mockup-mini,
        .mockup__btn,
        .pin-panel__actions button { transition: none !important; transform: none !important; }
      }
    </style>
  </head>
  <body class="${layoutClass}">
    <a class="back" href="../../../index.html">Voltar</a>
    <div class="wrap">
      <header class="hero">
        <div class="hero__meta">
          <div class="hero__info">
            <div class="eyebrow">Projeto do dia · ${today}</div>
            <h1>${safeTitle}</h1>
          </div>
          <div class="hero__actions">
            <span class="hero__tag">${safeDomain}</span>
            <button class="hero__btn" id="pin-config">Fixar</button>
            <button class="hero__btn" id="dl-tech">Baixar ficha técnica</button>
          </div>
        </div>
        <div class="hero__visual">
          <div class="hero__canvas" aria-hidden="true">
            <span class="hero__shape hero__shape--one"></span>
            <span class="hero__shape hero__shape--two"></span>
            <span class="hero__shape hero__shape--three"></span>
          </div>
          <div class="hero__summary">
            <span class="hero__chip hero__chip--accent">${mantra}</span>
          </div>
        </div>
      </header>
      <main class="preview-stage">
        <div class="preview-stage__inner">
          ${stageHtml}
        </div>
      </main>
      <aside class="pin-panel" data-pin-panel>
        <h2 class="pin-panel__title">Combinação fixa</h2>
        <p class="pin-panel__note">Os pesos podem ser ajustados para favorecer um dos eixos na próxima execução.</p>
        <div class="weight-list" data-weight-list>
          <div class="weight-item"><span>Tema</span><input type="range" min="10" max="70" value="${Math.round(profile.weights.theme * 100)}" step="5" data-weight-input="theme" /></div>
          <div class="weight-item"><span>Layout</span><input type="range" min="10" max="70" value="${Math.round(profile.weights.layout * 100)}" step="5" data-weight-input="layout" /></div>
          <div class="weight-item"><span>Texturas</span><input type="range" min="5" max="60" value="${Math.round(profile.weights.pattern * 100)}" step="5" data-weight-input="pattern" /></div>
        </div>
        <div class="pin-panel__permalink" data-pin-link aria-live="polite"></div>
        <div class="pin-panel__actions">
          <button type="button" data-pin-export>Exportar JSON</button>
          <button type="button" data-pin-copy>Copiar permalink</button>
        </div>
      </aside>
    </div>
    <script>
      const featureData = ${featureData};
      const previewProfile = ${profileData};
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
            'Direção visual:',
            '${mantra}',
            '',
            'Requisitos de implementação:',
            '- Tema base: ' + previewProfile.themeId,
            '- Layout: ' + previewProfile.layoutId,
            '- Textura: ' + previewProfile.patternId
          ];
          if (previewProfile.mockupId) {
            lines.push('- Mockup: ' + previewProfile.mockupId);
          }
          lines.push('', 'Pesos sugeridos:');
          lines.push('- Tema: ' + Math.round(previewProfile.weights.theme * 100) + '%');
          lines.push('- Layout: ' + Math.round(previewProfile.weights.layout * 100) + '%');
          lines.push('- Texturas: ' + Math.round(previewProfile.weights.pattern * 100) + '%');
          if (Array.isArray(previewProfile.parts) && previewProfile.parts.length) {
            lines.push('', 'Componentes em destaque:');
            previewProfile.parts.forEach((part) => lines.push('- ' + part));
          }
          lines.push('', 'Features essenciais:');
          featureData.forEach((feat) => lines.push('- ' + feat));
          lines.push('', 'Cores principais:', '- Accent: ' + previewProfile.accent);
          lines.push('', 'Seed determinístico: ' + previewProfile.seed);
          const text = lines.join('
');
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
      (function(){
        const panel = document.querySelector('[data-pin-panel]');
        const pinBtn = document.getElementById('pin-config');
        const exportBtn = panel?.querySelector('[data-pin-export]');
        const copyBtn = panel?.querySelector('[data-pin-copy]');
        const weightInputs = panel ? panel.querySelectorAll('[data-weight-input]') : [];
        const linkEl = panel?.querySelector('[data-pin-link]');
        if (!panel || !pinBtn || !linkEl) return;
        let weights = { ...previewProfile.weights };
        const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
        const normalizeWeights = () => {
          const total = weights.theme + weights.layout + weights.pattern;
          if (!total) return;
          weights = {
            theme: Number((weights.theme / total).toFixed(2)),
            layout: Number((weights.layout / total).toFixed(2)),
            pattern: Number((weights.pattern / total).toFixed(2))
          };
        };
        const updateLink = () => {
          const params = new URLSearchParams({
            seed: String(previewProfile.seed),
            theme: previewProfile.themeId,
            layout: previewProfile.layoutId,
            pattern: previewProfile.patternId
          });
          if (previewProfile.mockupId) {
            params.set('mockup', previewProfile.mockupId);
          }
          const base = window.location.href.split('?')[0];
          const permalink = base + '?' + params.toString();
          linkEl.textContent = permalink;
          linkEl.dataset.href = permalink;
        };
        updateLink();
        pinBtn.addEventListener('click', () => {
          panel.classList.toggle('is-visible');
          if (panel.classList.contains('is-visible')) {
            updateLink();
            pinBtn.setAttribute('aria-pressed', 'true');
          } else {
            pinBtn.setAttribute('aria-pressed', 'false');
          }
        });
        weightInputs.forEach((input) => {
          input.addEventListener('input', () => {
            const type = input.dataset.weightInput;
            const normalized = clamp(Number(input.value) / 100, 0.05, 0.7);
            weights = { ...weights, [type]: Number(normalized.toFixed(2)) };
          });
          input.addEventListener('change', () => {
            normalizeWeights();
          });
        });
        exportBtn?.addEventListener('click', () => {
          normalizeWeights();
          const payload = {
            ...previewProfile,
            weights,
            exportedAt: new Date().toISOString()
          };
          const text = JSON.stringify(payload, null, 2);
          const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'preview-pin-' + previewProfile.key + '.json';
          document.body.appendChild(a);
          a.click();
          requestAnimationFrame(() => {
            URL.revokeObjectURL(url);
            a.remove();
          });
        });
        copyBtn?.addEventListener('click', async () => {
          if (!linkEl.dataset.href) return;
          try {
            await navigator.clipboard.writeText(linkEl.dataset.href);
            copyBtn.textContent = 'Copiado!';
            setTimeout(() => { copyBtn.textContent = 'Copiar permalink'; }, 1600);
          } catch {
            copyBtn.textContent = 'Falha ao copiar';
            setTimeout(() => { copyBtn.textContent = 'Copiar permalink'; }, 1600);
          }
        });
      }());
    </script>
  </body>
</html>`;
}


function generateProceduralPreview(key, idea, cache = {}) {
  const seed = ideaSeedFromDate(key);
  const rng = createSeededRng(seed);
  const recentVariants = Array.isArray(cache.recentVariants) ? cache.recentVariants.filter(Boolean).slice(-50) : [];
  const lastVariant = recentVariants.length ? recentVariants[recentVariants.length - 1] : null;

  let theme = createTheme(rng, { lastVariant });
  let layoutVariant = selectLayoutVariant(rng, { lastVariant });
  let patternVariant = selectPatternVariant(rng, { lastVariant, theme });
  let mockup = buildAppMockup({ key, idea, theme, rng, layout: layoutVariant });
  let signature = buildVariantSignature(theme.id, layoutVariant.id, patternVariant.id, mockup.signature);

  let attempts = 0;
  while (recentVariants.some((entry) => entry.signature === signature) && attempts < 6) {
    layoutVariant = selectLayoutVariant(rng, { lastVariant, avoidId: layoutVariant.id });
    patternVariant = selectPatternVariant(rng, { lastVariant, avoidId: patternVariant.id, theme });
    mockup = buildAppMockup({ key, idea, theme, rng, layout: layoutVariant });
    signature = buildVariantSignature(theme.id, layoutVariant.id, patternVariant.id, mockup.signature);
    attempts += 1;
    if (attempts >= 3) {
      theme = createTheme(rng, { lastVariant: { ...lastVariant, themeId: theme.id, accent: theme.accent } });
      patternVariant = selectPatternVariant(rng, { lastVariant, theme });
      mockup = buildAppMockup({ key, idea, theme, rng, layout: layoutVariant });
      signature = buildVariantSignature(theme.id, layoutVariant.id, patternVariant.id, mockup.signature);
    }
  }

  const features = ensureFeatureList(idea.features, rng, layoutVariant.featureCount ?? 3);
  const mottoSource = randomPick(POWER_LINES, rng) || POWER_LINES[0];
  const motto = toMicroCopy(mottoSource, 3);
  const weights = { theme: 0.42, layout: 0.33, pattern: 0.25 };
  const headingWeight = layoutVariant.id === 'poster' ? BASE_TYPOGRAPHY.altHeadingWeight : BASE_TYPOGRAPHY.baseHeadingWeight;
  const typography = { ...BASE_TYPOGRAPHY, headingWeight };
  const profile = {
    seed,
    key,
    themeId: theme.id,
    layoutId: layoutVariant.id,
    patternId: patternVariant.id,
    mockupId: mockup.id,
    signature,
    accent: theme.accent,
    weights,
    parts: mockup.parts || [],
    heroMode: layoutVariant.heroMode || 'gallery'
  };

  return {
    html: renderProceduralShell({
      key,
      idea,
      theme,
      features,
      motto,
      patternCss: patternVariant.css,
      profile,
      typography,
      layoutId: layoutVariant.id,
      heroMode: layoutVariant.heroMode || 'gallery',
      layoutCss: layoutVariant.css || '',
      mockup
    }),
    variant: profile
  };
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
  let variantRecord = null;
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
        const generated = generateProceduralPreview(key, idea, cache);
        html = generated.html;
        variantRecord = generated.variant;
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
    const generated = generateProceduralPreview(key, fallbackIdea, cache);
    html = generated.html;
    variantRecord = generated.variant;
    meta = { source: 'local-procedural', title: fallbackIdea.title, subtitle: fallbackIdea.domain, template: 'procedural-lab' };
  }

  const recentList = Array.isArray(cache.recentVariants) ? cache.recentVariants.filter(Boolean) : [];
  if (variantRecord) {
    recentList.push(variantRecord);
    while (recentList.length > 50) recentList.shift();
    cache.recentVariants = recentList;
    cache.lastVariant = variantRecord;
  } else if (!Array.isArray(cache.recentVariants)) {
    cache.recentVariants = recentList;
  }

  cache.lastKey = key;

  // Escrita atômica e somente se mudar (evita conflitos de save em editores)
  const htmlChanged = await atomicWriteIfChanged(PREVIEW2_PATH, html, 'utf8');
  const cachePayload = {
    lastKey: cache.lastKey,
    meta,
    recentVariants: cache.recentVariants || [],
    lastVariant: cache.lastVariant || null
  };
  const cacheChanged = await atomicWriteIfChanged(
    PREVIEW2_CACHE_JSON,
    JSON.stringify(cachePayload, null, 2),
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
