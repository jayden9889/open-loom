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

/** Generous but finite: a wedged local Ollama otherwise hangs the UI forever. */
const AI_TIMEOUT_MS = 5 * 60 * 1000;

const inFlight = new Map<string, { controller: AbortController; timedOut: boolean }>();

/** Abort this video's in-flight generation; the pending generateAI call rejects. */
export function cancelAI(id: string): void {
  inFlight.get(id)?.controller.abort();
}

/** True when a stored value exists for this kind (would be destroyed by a regenerate). */
function hasStoredValue(meta: VideoMeta, kind: AiKind): boolean {
  const ai = meta.ai;
  if (!ai) return false;
  if (kind === 'title') return Boolean(ai.title);
  if (kind === 'summary') return Boolean(ai.summary);
  if (kind === 'chapters') return (ai.chapters?.length ?? 0) > 0;
  return (ai.tasks?.length ?? 0) > 0;
}

/**
 * Generate the requested kinds from the transcript and merge them into
 * meta.ai. A generated title also becomes the video title when the user has
 * not renamed the recording away from its automatic name (SPEC L6).
 *
 * Hand-edited results are never overwritten silently: once meta.ai.edited is
 * set, kinds that already hold a value are skipped unless `force` is passed
 * (the renderer's Regenerate path, behind a confirm).
 */
export async function generateAI(id: string, kinds: string[], force = false): Promise<void> {
  const store = library();
  const meta = store.get(id);
  let wanted = normalizeKinds(kinds);
  const cfg = providerConfig();
  const segments = readSegments(store.videoDir(id));
  if (inFlight.has(id)) {
    throw new Error('AI generation is already running for this video.');
  }
  if (!force && meta.ai?.edited) {
    wanted = wanted.filter((k) => !hasStoredValue(meta, k));
    if (wanted.length === 0) {
      throw new Error('These AI results have been hand-edited. Use Regenerate to replace them.');
    }
  }

  const flight = { controller: new AbortController(), timedOut: false };
  const timer = setTimeout(() => {
    flight.timedOut = true;
    flight.controller.abort();
  }, AI_TIMEOUT_MS);
  inFlight.set(id, flight);
  emitJobProgress({ videoId: id, kind: 'ai', pct: 5, note: 'Generating with AI' });
  try {
    const result = await generate(cfg, meta, segments, wanted, flight.controller.signal);
    const produced = Object.keys(result).length;
    if (produced === 0) {
      throw new Error('The model responded but produced nothing usable. Try again or switch models.');
    }

    const nextAi: NonNullable<VideoMeta['ai']> = { ...meta.ai, ...result };
    delete nextAi.stale;
    delete nextAi.error;
    if (force) delete nextAi.edited;
    const patch: Partial<VideoMeta> = { ai: nextAi };
    if (result.title && looksAutoNamed(meta.title)) {
      patch.title = result.title;
    }
    store.update(id, patch);
    emitJobProgress({ videoId: id, kind: 'ai', pct: 100, note: 'AI results ready' });
  } catch (err) {
    emitJobProgress({ videoId: id, kind: 'ai', pct: 100, note: 'AI generation failed' });
    if (flight.controller.signal.aborted) {
      throw new Error(
        flight.timedOut
          ? 'The AI provider did not respond within 5 minutes, so the request was stopped. Check the provider in Settings and try again.'
          : 'AI generation was cancelled.'
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    inFlight.delete(id);
  }
}

/** True for titles still matching the automatic name pattern (never renamed). */
export function looksAutoNamed(title: string): boolean {
  return /^Recording\b/i.test(title.trim());
}

/**
 * Auto-run hook chained after transcription (SPEC A1). Never forces, so
 * hand-edited results survive an automatic pass. A failure is persisted on
 * the video (meta.ai.error) so the renderer can show it instead of the user
 * concluding the feature silently does nothing.
 */
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
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`auto AI generation for ${id} failed: ${msg}`);
    try {
      const meta = library().get(id);
      library().update(id, { ai: { ...meta.ai, error: msg } });
    } catch (persistErr) {
      log.warn(`could not record the AI failure on ${id}: ${String(persistErr)}`);
    }
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
