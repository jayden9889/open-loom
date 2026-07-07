/**
 * AI core (SPEC A1): provider-agnostic prompt building, per-provider request
 * shaping for Anthropic Messages, OpenAI-compatible chat completions and
 * Ollama chat (all plain fetch), strict-JSON response parsing and validation
 * of generated chapters against the video duration. Pure Node so it is
 * unit-testable against a mock HTTP server; ai.ts binds it to settings.
 */
import type { TranscriptSegment, VideoMeta } from '@shared/types';

export type AiKind = 'title' | 'summary' | 'chapters' | 'tasks';

export const AI_KINDS: AiKind[] = ['title', 'summary', 'chapters', 'tasks'];

export interface AiProviderConfig {
  provider: 'anthropic' | 'openai' | 'ollama';
  endpoint: string;
  model: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export interface AiGenerationResult {
  title?: string;
  summary?: string;
  chapters?: { t: number; title: string }[];
  tasks?: string[];
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Cap the transcript so prompts stay well inside context windows. */
const MAX_TRANSCRIPT_CHARS = 24_000;

export function buildPrompt(meta: VideoMeta, segments: TranscriptSegment[], kinds: AiKind[]): string {
  let transcript = segments
    .map((s) => `[${formatClock(s.start)}] ${s.text.trim()}`)
    .join('\n');
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    const head = transcript.slice(0, MAX_TRANSCRIPT_CHARS * 0.7);
    const tail = transcript.slice(-MAX_TRANSCRIPT_CHARS * 0.25);
    transcript = `${head}\n[...transcript shortened...]\n${tail}`;
  }

  const wanted: string[] = [];
  if (kinds.includes('title')) {
    wanted.push('"title": a short, specific video title under 70 characters, no quotes around it');
  }
  if (kinds.includes('summary')) {
    wanted.push('"summary": 2-4 sentences summarising what the video covers and any conclusions');
  }
  if (kinds.includes('chapters')) {
    wanted.push(
      `"chapters": 3-8 objects {"t": <start time in seconds as a number>, "title": <short chapter name>} in ascending order. Every "t" must be between 0 and ${Math.floor(meta.durationSec)} (the video duration in seconds) and should match where the topic starts in the transcript timestamps`
    );
  }
  if (kinds.includes('tasks')) {
    wanted.push(
      '"tasks": an array of short action items explicitly mentioned or clearly implied in the video (empty array if none)'
    );
  }

  return [
    `You are helping annotate a screen recording titled "${meta.title}" (duration ${Math.round(meta.durationSec)}s).`,
    'The transcript below has [m:ss] start timestamps per line.',
    '',
    'Respond with ONLY a single JSON object, no prose and no code fences, containing exactly these keys:',
    ...wanted.map((w) => `- ${w}`),
    '',
    'Transcript:',
    transcript,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Endpoint shaping
// ---------------------------------------------------------------------------

function stripTrailingSlash(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function anthropicUrl(endpoint: string): string {
  const base = stripTrailingSlash(endpoint) || 'https://api.anthropic.com';
  return /\/v\d+\/messages$/.test(base) ? base : `${base}/v1/messages`;
}

export function openAiChatUrl(endpoint: string): string {
  const base = stripTrailingSlash(endpoint);
  if (!base) throw new Error('Set the API endpoint base URL in Settings first.');
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export function ollamaChatUrl(endpoint: string): string {
  const base = stripTrailingSlash(endpoint) || 'http://localhost:11434';
  return /\/api\/chat$/.test(base) ? base : `${base}/api/chat`;
}

// ---------------------------------------------------------------------------
// Completion call (single-turn, plain fetch)
// ---------------------------------------------------------------------------

async function readError(res: Response): Promise<string> {
  const body = (await res.text()).slice(0, 300);
  return `${res.status}: ${body}`;
}

export async function complete(cfg: AiProviderConfig, prompt: string): Promise<string> {
  const doFetch = cfg.fetchImpl ?? fetch;
  if (!cfg.model.trim()) {
    throw new Error('Set a model name in Settings first.');
  }

  if (cfg.provider === 'anthropic') {
    if (!cfg.apiKey) throw new Error('Add your Anthropic API key in Settings first.');
    const res = await doFetch(anthropicUrl(cfg.endpoint), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic returned ${await readError(res)}`);
    const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    if (!text.trim()) throw new Error('Anthropic returned an empty response.');
    return text;
  }

  if (cfg.provider === 'openai') {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.apiKey) headers['authorization'] = `Bearer ${cfg.apiKey}`;
    const res = await doFetch(openAiChatUrl(cfg.endpoint), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
      }),
    });
    if (!res.ok) throw new Error(`The API returned ${await readError(res)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) throw new Error('The API returned an empty response.');
    return text;
  }

  // Ollama
  const res = await doFetch(ollamaChatUrl(cfg.endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`Ollama returned ${await readError(res)}`);
  const data = (await res.json()) as { message?: { content?: string } };
  const text = data.message?.content ?? '';
  if (!text.trim()) throw new Error('Ollama returned an empty response.');
  return text;
}

// ---------------------------------------------------------------------------
// Response parsing + validation
// ---------------------------------------------------------------------------

/** Pull the first top-level JSON object out of a model response. */
export function extractJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) throw new Error('The model did not return JSON.');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(cleaned.slice(start, i + 1)) as Record<string, unknown>;
      }
    }
  }
  throw new Error('The model returned incomplete JSON.');
}

/** Validate + normalise chapters against the video duration (SPEC A1). */
export function validateChapters(
  raw: unknown,
  durationSec: number
): { t: number; title: string }[] {
  if (!Array.isArray(raw)) return [];
  const chapters = raw
    .map((c) => {
      if (typeof c !== 'object' || c === null) return null;
      const obj = c as { t?: unknown; title?: unknown };
      const t = typeof obj.t === 'number' ? obj.t : Number(obj.t);
      const title = typeof obj.title === 'string' ? obj.title.trim() : '';
      if (!Number.isFinite(t) || !title) return null;
      if (t < 0 || t > durationSec) return null;
      return { t: Math.round(t * 10) / 10, title: title.slice(0, 120) };
    })
    .filter((c): c is { t: number; title: string } => c !== null)
    .sort((a, b) => a.t - b.t);
  // De-duplicate chapters that landed on the same second.
  const out: { t: number; title: string }[] = [];
  for (const c of chapters) {
    if (out.length === 0 || c.t - out[out.length - 1]!.t >= 1) out.push(c);
  }
  return out;
}

export function parseGeneration(text: string, kinds: AiKind[], durationSec: number): AiGenerationResult {
  const obj = extractJsonObject(text);
  const result: AiGenerationResult = {};
  if (kinds.includes('title') && typeof obj['title'] === 'string' && obj['title'].trim()) {
    result.title = obj['title'].trim().slice(0, 140);
  }
  if (kinds.includes('summary') && typeof obj['summary'] === 'string' && obj['summary'].trim()) {
    result.summary = obj['summary'].trim();
  }
  if (kinds.includes('chapters')) {
    const chapters = validateChapters(obj['chapters'], durationSec);
    if (chapters.length > 0) result.chapters = chapters;
  }
  if (kinds.includes('tasks') && Array.isArray(obj['tasks'])) {
    const tasks = obj['tasks']
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim().slice(0, 300));
    result.tasks = tasks;
  }
  return result;
}

/** One end-to-end generation pass. */
export async function generate(
  cfg: AiProviderConfig,
  meta: VideoMeta,
  segments: TranscriptSegment[],
  kinds: AiKind[]
): Promise<AiGenerationResult> {
  if (kinds.length === 0) return {};
  const prompt = buildPrompt(meta, segments, kinds);
  const text = await complete(cfg, prompt);
  return parseGeneration(text, kinds, meta.durationSec);
}

/** Tiny request used by Settings "Test connection". */
export async function testConnection(cfg: AiProviderConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    const text = await complete(cfg, 'Reply with the single word: ok');
    if (!text.trim()) return { ok: false, error: 'The model returned an empty response.' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
