/**
 * AI binding (SPEC A1): reads the configured provider from settings (key via
 * safeStorage), feeds transcript.json into the ai-core generator, stores the
 * results under meta.ai (chapters validated against duration), applies the AI
 * title per SPEC L6, and exposes the Settings "Test connection" check.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TranscriptSegment, VideoMeta } from '@shared/types';
import { VIDEO_FILES } from '@shared/types';
import { getSettings, getSecret } from './settings';
import { library } from './library';
import { emitJobProgress } from './ffmpeg';
import { AI_KINDS, generate, testConnection, type AiKind, type AiProviderConfig } from './ai-core';
import { log } from './logger';

function providerConfig(): AiProviderConfig {
  const cfg = getSettings().ai;
  if (cfg.provider === 'off') {
    throw new Error('AI features are turned off. Pick a provider in Settings, then try again.');
  }
  return {
    provider: cfg.provider,
    endpoint: cfg.endpoint,
    model: cfg.model,
    apiKey: getSecret('ai.apiKey'),
  };
}

function readSegments(videoDir: string): TranscriptSegment[] {
  const transcriptPath = path.join(videoDir, VIDEO_FILES.transcriptJson);
  if (!fs.existsSync(transcriptPath)) {
    throw new Error('This video has no transcript yet. Transcribe it first, then generate AI results.');
  }
  try {
    const data = JSON.parse(fs.readFileSync(transcriptPath, 'utf8')) as { segments?: TranscriptSegment[] };
    const segments = data.segments ?? [];
    if (segments.length === 0) throw new Error('empty');
    return segments;
  } catch {
    throw new Error('The transcript for this video could not be read. Re-run transcription, then try again.');
  }
}

function normalizeKinds(kinds: string[]): AiKind[] {
  const valid = kinds.filter((k): k is AiKind => (AI_KINDS as string[]).includes(k));
  if (valid.length === 0) {
    throw new Error('Nothing to generate: pick at least one of title, summary, chapters or tasks.');
  }
  return valid;
}

const inFlight = new Set<string>();

/**
 * Generate the requested kinds from the transcript and merge them into
 * meta.ai. A generated title also becomes the video title when the user has
 * not renamed the recording away from its automatic name (SPEC L6).
 */
export async function generateAI(id: string, kinds: string[]): Promise<void> {
  const store = library();
  const meta = store.get(id);
  const wanted = normalizeKinds(kinds);
  const cfg = providerConfig();
  const segments = readSegments(store.videoDir(id));
  if (inFlight.has(id)) {
    throw new Error('AI generation is already running for this video.');
  }

  inFlight.add(id);
  emitJobProgress({ videoId: id, kind: 'ai', pct: 5, note: 'Generating with AI' });
  try {
    const result = await generate(cfg, meta, segments, wanted);
    const produced = Object.keys(result).length;
    if (produced === 0) {
      throw new Error('The model responded but produced nothing usable. Try again or switch models.');
    }

    const patch: Partial<VideoMeta> = { ai: { ...meta.ai, ...result } };
    if (result.title && looksAutoNamed(meta.title)) {
      patch.title = result.title;
    }
    store.update(id, patch);
    emitJobProgress({ videoId: id, kind: 'ai', pct: 100, note: 'AI results ready' });
  } catch (err) {
    emitJobProgress({ videoId: id, kind: 'ai', pct: 100, note: 'AI generation failed' });
    throw err;
  } finally {
    inFlight.delete(id);
  }
}

/** True for titles still matching the automatic name pattern (never renamed). */
export function looksAutoNamed(title: string): boolean {
  return /^Recording\b/i.test(title.trim());
}

/** Auto-run hook chained after transcription (SPEC A1). */
export async function maybeAutoGenerateAI(id: string): Promise<void> {
  const cfg = getSettings().ai;
  if (cfg.provider === 'off') return;
  const kinds = (Object.entries(cfg.features) as [AiKind, boolean][])
    .filter(([, on]) => on)
    .map(([k]) => k);
  if (kinds.length === 0) return;
  try {
    await generateAI(id, kinds);
  } catch (err) {
    log.warn(`auto AI generation for ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Settings "Test connection" (SPEC G5): verifies the saved provider config. */
export async function testAI(): Promise<{ ok: boolean; error?: string }> {
  const cfg = getSettings().ai;
  if (cfg.provider === 'off') {
    return { ok: false, error: 'Pick a provider first.' };
  }
  return testConnection({
    provider: cfg.provider,
    endpoint: cfg.endpoint,
    model: cfg.model,
    apiKey: getSecret('ai.apiKey'),
  });
}
