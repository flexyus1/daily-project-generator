// GPT provider (opcional). Requer rede e OPENAI_API_KEY.
// APIs disponíveis:
// - generateProjectIdea(utcKey): retorna metadados simples { title, domain, why, features, slug }
// - generateProjectApp(utcKey): retorna um miniprojeto completo

import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const previewsDir = path.join(rootDir, 'src', 'previews');
const PREVIEW1_PATH = path.join(previewsDir, 'preview-1.html');
const PREVIEW2_PATH = path.join(previewsDir, 'preview-2.html');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5';

function slugify(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

function seedFromKey(key) {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) {
    h = (h * 33 + key.charCodeAt(i)) >>> 0;
  }
  return h;
}

function select(list, seed, shift = 0) {
  if (!list.length) return '';
  const idx = (seed >>> shift) % list.length;
  return list[idx];
}

async function safeRead(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function stripHtmlToSnippet(html, limit = 2800) {
  if (!html) return '';
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function extractTitle(html) {
  if (!html) return null;
  const match = html.match(/<title>([^<]*)<\/title>/i);
  return match ? match[1].trim() : null;
}

async function loadPreviewContext() {
  const [p1, p2] = await Promise.all([safeRead(PREVIEW1_PATH), safeRead(PREVIEW2_PATH)]);
  return {
    preview1: stripHtmlToSnippet(p1, 3200),
    preview2: stripHtmlToSnippet(p2, 3200),
    preview1Title: extractTitle(p1) || 'Preview 1',
    preview2Title: extractTitle(p2) || 'Preview 2 atual'
  };
}

function buildCreativeBrief(seed) {
  const directions = [
    'misture mecânicas de picks & bans com hábitos de treino individuais',
    'conecte produtividade pessoal com decisões estratégicas de draft',
    'transforme insights de champion select em rotinas de prática diárias',
    'aproveite timers e sugestões para criar assistentes de treino úteis',
    'gere dashboards que unam planejamento de partida e foco de jogadores',
    'crie ferramentas que convertam recomendações de campeões em ações concretas'
  ];
  const extraAngles = [
    'inclua métricas simples e objetivos acionáveis',
    'priorize acessibilidade e uso rápido em partidas ranqueadas',
    'forneça fichas técnicas baixáveis para revisar estratégias',
    'permita registrar decisões e compromissos em poucos cliques',
    'ofereça feedback visual claro e motivações curtas',
    'combine checklists com timers contextuais'
  ];
  return {
    direction: select(directions, seed, 0),
    angle: select(extraAngles, seed, 5)
  };
}

export async function generateProjectIdea(utcKey) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY ausente');

  const seed = seedFromKey(utcKey);
  const { preview1, preview2, preview1Title, preview2Title } = await loadPreviewContext();
  const brief = buildCreativeBrief(seed);

  const system = 'Você é um assistente que gera ideias de projetos diários úteis para devs iniciantes. Use as referências fornecidas como base e responda apenas JSON.';
  const prompt = `Gere uma única ideia de projeto para a data UTC ${utcKey}.
Requisitos:
- deve ser útil e acionável, sem depender de backend
- considere como reutilizar ou evoluir elementos de "${preview1Title}" e "${preview2Title}"
- apresente domínio, justificativa e 3 features essenciais e distintas
- mantenha linguagem em português do Brasil

Direção criativa do dia: ${brief.direction}; ${brief.angle}.

Formato JSON:
{
  "title": string,
  "domain": string,
  "why": string,
  "features": [string, string, string]
}`;

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: prompt }
  ];

  if (preview1) {
    messages.push({
      role: 'user',
      content: `Resumo do Preview 1 (${preview1Title}):\n${preview1}`
    });
  }
  if (preview2) {
    messages.push({
      role: 'user',
      content: `Resumo do Preview 2 atual (${preview2Title}):\n${preview2}`
    });
  }

  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.85,
      response_format: { type: 'json_object' }
    })
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`OpenAI error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content);
  const title = parsed.title || 'Projeto do Dia';
  const domain = parsed.domain || 'Produtividade';
  const why = parsed.why || 'resolve um problema direto e recorrente.';
  const features = Array.isArray(parsed.features) && parsed.features.length ? parsed.features.slice(0, 3) : [
    'CRUD básico',
    'Persistência local',
    'UX clara'
  ];

  return {
    key: utcKey,
    title,
    domain,
    why,
    features,
    slug: slugify(title)
  };
}

export async function generateProjectApp(utcKey) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY ausente');

  const seed = seedFromKey(utcKey);
  const { preview1, preview2, preview1Title, preview2Title } = await loadPreviewContext();
  const brief = buildCreativeBrief(seed);

  const system = 'Você é um gerador de miniprojetos front-end autocontidos, sem dependências externas. Responda apenas JSON.';
  const prompt = `Crie um único arquivo HTML COMPLETO (doctype, head, body) com CSS e JS inline.
Referência central: use "${preview1Title}" como guia para a estrutura limpa e navegável, porém entregue uma identidade visual inédita (paleta, ritmo, grafismos).
Referência complementar: "${preview2Title}" pode inspirar microinterações e animações sutis.

Requisitos:
- Visual minimalista com blocos/grids, respiros generosos e foco em elementos visuais; evite parágrafos longos.
- Combine elementos de champion select com rotinas ou produtividade.
- Interface compreensível em poucos segundos, textos super curtos e acionáveis.
- Acessível (roles ARIA básicos, foco visível)
- Sem frameworks, sem fontes externas
- Interativo: mínimo 3 elementos com comportamento (ex.: selects, timers, checklists).
- Botão "Reset" e link "Voltar" para '../../../index.html'.
- Disponibilize um botão que gere ficha técnica em texto (download) descrevendo o projeto com as instruções detalhadas.
- Linguagem e textos em pt-BR.

Direção criativa do dia: ${brief.direction}; ${brief.angle}.
Produza algo útil, agradável de usar e fácil de entender.`;

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: prompt }
  ];

  if (preview1) {
    messages.push({ role: 'user', content: `Referência Preview 1 (${preview1Title}):\n${preview1}` });
  }
  if (preview2) {
    messages.push({ role: 'user', content: `Referência Preview 2 atual (${preview2Title}):\n${preview2}` });
  }

  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.65,
      response_format: { type: 'json_object' }
    })
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`OpenAI error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content);
  const title = parsed.title || 'DraftSense Mini';
  const html = parsed.html || '';

  return {
    title,
    slug: slugify(title),
    html
  };
}
