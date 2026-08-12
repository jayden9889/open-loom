/**
 * Transcription core (SPEC T1-T3): pure logic with no Electron imports so it
 * is unit-testable. Covers WebVTT formatting/parsing, whisper.cpp JSON output
 * parsing, OpenAI-compatible /v1/audio/transcriptions response parsing, and
 * the engine-agnostic pipeline that turns an audio file into transcript.vtt
 * plus transcript.json. transcribe.ts binds this to settings + IPC.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { TranscriptResult, TranscriptSegment, TranscriptionProvider } from '@shared/types';

// ---------------------------------------------------------------------------
// WebVTT
// ---------------------------------------------------------------------------

/** 12.345 -> "00:00:12.345" */
export function formatVttTime(sec: number): string {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/** "00:00:12.345" or "00:12.345" or "00:12,345" -> seconds. */
export function parseVttTime(t: string): number {
  const parts = t.trim().split(':');
  let sec = 0;
  for (const p of parts) sec = sec * 60 + parseFloat(p.replace(',', '.'));
  return Number.isFinite(sec) ? sec : 0;
}

export function buildVtt(segments: TranscriptSegment[]): string {
  const lines = ['WEBVTT', ''];
  segments.forEach((seg, i) => {
    lines.push(String(i + 1));
    lines.push(`${formatVttTime(seg.start)} --> ${formatVttTime(seg.end)}`);
    lines.push(seg.text.trim());
    lines.push('');
  });
  return lines.join('\n');
}

export function parseVttToSegments(raw: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const blocks = raw.replace(/\r/g, '').split('\n\n');
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim().length > 0);
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue;
    const [startRaw, endRaw] = lines[timeIdx]!.split('-->');
    if (!startRaw || !endRaw) continue;
    const text = lines
      .slice(timeIdx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!text) continue;
    segments.push({
      start: parseVttTime(startRaw),
      end: parseVttTime(endRaw.trim().split(' ')[0] ?? endRaw),
      text,
    });
  }
  return segments;
}

/**
 * Map one timestamp from the original timeline onto the trimmed one, or null
 * when it fell inside a removed section. `ranges` are the kept ranges in order.
 */
export function retimeThroughRanges(
  t: number,
  ranges: { start: number; end: number }[]
): number | null {
  let elapsed = 0;
  for (const r of ranges) {
    if (t < r.start) return null;
    if (t <= r.end) return elapsed + (t - r.start);
    elapsed += r.end - r.start;
  }
  return null;
}

/**
 * Re-time transcript segments onto a trimmed timeline. A trim shifts everything
 * after each cut, so leaving the transcript alone left it describing a video
 * that no longer exists: lines pointed at the wrong moment, library search
 * matched words that had been cut out, and AI regeneration read the stale copy.
 * Segments spanning a cut are clipped to the parts that survived.
 */
export function retimeSegments(
  segments: TranscriptSegment[],
  ranges: { start: number; end: number }[]
): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let elapsed = 0;
  for (const r of ranges) {
    for (const s of segments) {
      const start = Math.max(s.start, r.start);
      const end = Math.min(s.end, r.end);
      if (end - start < 0.01) continue;
      out.push({ start: elapsed + (start - r.start), end: elapsed + (end - r.start), text: s.text });
    }
    elapsed += r.end - r.start;
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * A transcript that could not be re-timed is set aside under these names
 * instead of being deleted: the user may have paid an API for it, and a
 * mis-timed copy on disk beats silent destruction. A later successful
 * transcription cleans them up.
 */
export const STALE_TRANSCRIPT_JSON = 'transcript.stale.json';
export const STALE_CAPTIONS_VTT = 'transcript.stale.vtt';

export type TranscriptRetimeOutcome =
  | { status: 'absent' }
  | { status: 'retimed'; segments: TranscriptSegment[] }
  | { status: 'failed'; error: string };

/**
 * Re-time transcript.json + transcript.vtt in `dir` onto a trimmed timeline.
 * A transcript that cannot be re-timed (corrupt JSON) is renamed to the
 * `.stale` names rather than deleted, so the failure is recoverable and the
 * caller can tell the user what happened instead of the files just vanishing.
 */
export function applyTranscriptRetime(
  dir: string,
  ranges: { start: number; end: number }[]
): TranscriptRetimeOutcome {
  const jsonPath = path.join(dir, 'transcript.json');
  if (!fs.existsSync(jsonPath)) return { status: 'absent' };
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as {
      segments?: TranscriptSegment[];
    };
    const retimed = retimeSegments(data.segments ?? [], ranges);
    fs.writeFileSync(jsonPath, JSON.stringify({ ...data, segments: retimed }, null, 2));
    fs.writeFileSync(path.join(dir, 'transcript.vtt'), buildVtt(retimed));
    return { status: 'retimed', segments: retimed };
  } catch (err) {
    for (const [live, stale] of [
      ['transcript.json', STALE_TRANSCRIPT_JSON],
      ['transcript.vtt', STALE_CAPTIONS_VTT],
    ] as const) {
      const from = path.join(dir, live);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, stale));
    }
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Remove set-aside stale transcript files (called after a fresh transcription lands). */
export function cleanStaleTranscriptFiles(dir: string): void {
  fs.rmSync(path.join(dir, STALE_TRANSCRIPT_JSON), { force: true });
  fs.rmSync(path.join(dir, STALE_CAPTIONS_VTT), { force: true });
}

// ---------------------------------------------------------------------------
// Segment hygiene
// ---------------------------------------------------------------------------

/** Drop empty/invalid segments, sort, clamp negative times, round to ms. */
export function cleanSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const round = (n: number) => Math.round(Math.max(0, n) * 1000) / 1000;
  return segments
    .filter((s) => s.text.trim().length > 0 && Number.isFinite(s.start) && Number.isFinite(s.end))
    .map((s) => ({ start: round(s.start), end: round(Math.max(s.end, s.start)), text: s.text.trim() }))
    .sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// whisper.cpp output parsing
// ---------------------------------------------------------------------------

interface WhisperJsonShape {
  result?: { language?: string };
  transcription?: {
    offsets?: { from?: number; to?: number };
    text?: string;
  }[];
}

/** Parse whisper-cli --output-json file content into segments + language. */
export function parseWhisperJson(raw: string): { language: string; segments: TranscriptSegment[] } {
  const data = JSON.parse(raw) as WhisperJsonShape;
  const segments = (data.transcription ?? []).map((t) => ({
    start: (t.offsets?.from ?? 0) / 1000,
    end: (t.offsets?.to ?? 0) / 1000,
    text: (t.text ?? '').trim(),
  }));
  return { language: data.result?.language ?? 'en', segments: cleanSegments(segments) };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible response parsing
// ---------------------------------------------------------------------------

interface OpenAiVerboseShape {
  language?: string;
  duration?: number;
  text?: string;
  segments?: { start?: number; end?: number; text?: string }[];
}

/**
 * Parse a /v1/audio/transcriptions response. verbose_json gives timestamped
 * segments; plain endpoints that only return { text } fall back to one
 * segment spanning the known audio duration.
 */
export function parseOpenAiTranscription(
  raw: string,
  fallbackDurationSec: number
): { language: string; segments: TranscriptSegment[] } {
  const data = JSON.parse(raw) as OpenAiVerboseShape;
  if (Array.isArray(data.segments) && data.segments.length > 0) {
    return {
      language: data.language ?? 'auto',
      segments: cleanSegments(
        data.segments.map((s) => ({ start: s.start ?? 0, end: s.end ?? 0, text: s.text ?? '' }))
      ),
    };
  }
  const text = (data.text ?? '').trim();
  if (!text) return { language: data.language ?? 'auto', segments: [] };
  return {
    language: data.language ?? 'auto',
    segments: [{ start: 0, end: data.duration ?? fallbackDurationSec, text }],
  };
}

// ---------------------------------------------------------------------------
// whisper.cpp engine (spawns whisper-cli)
// ---------------------------------------------------------------------------

export interface WhisperEngineConfig {
  binaryPath: string;
  modelPath: string;
}

/**
 * whisper.cpp `.en` models silently ignore the language flag and emit English
 * gibberish for other languages, so a non-English request on one must fail
 * loudly instead (the guided installer only ships base.en today).
 */
export function whisperModelIsEnglishOnly(modelPath: string): boolean {
  return /\.en(-[^.]+)?\.bin$/i.test(path.basename(modelPath));
}

/** Plain-language error for a language the resolved whisper model cannot do, or null when fine. */
export function whisperLanguageProblem(modelPath: string, language: string): string | null {
  const lang = language.trim().toLowerCase();
  if (!lang || lang === 'auto' || lang === 'en' || lang === 'english') return null;
  if (!whisperModelIsEnglishOnly(modelPath)) return null;
  return `The installed whisper model is English-only, so it cannot transcribe "${language}". Use the API endpoint engine, or point Settings at a multilingual whisper model (e.g. ggml-base.bin).`;
}

/**
 * Short flags only: they are identical across whisper.cpp's old `main` and
 * the current `whisper-cli` binaries (-oj json out, -of prefix, -pp progress,
 * -np quiet).
 */
export function buildWhisperArgs(cfg: WhisperEngineConfig, audioPath: string, language: string, outPrefix: string): string[] {
  return [
    '-m', cfg.modelPath,
    '-f', audioPath,
    '-oj',
    '-of', outPrefix,
    '-pp',
    '-np',
    '-l', language && language !== 'auto' ? language : 'auto',
  ];
}

export function createWhisperEngine(cfg: WhisperEngineConfig): TranscriptionProvider {
  return {
    engine: 'whisper',
    async transcribe(audioPath, language, onProgress, signal): Promise<TranscriptResult> {
      if (!fs.existsSync(cfg.binaryPath)) {
        throw new Error('whisper-cli was not found. Install whisper.cpp from Settings or set its path.');
      }
      if (!fs.existsSync(cfg.modelPath)) {
        throw new Error('The whisper model file was not found. Install whisper.cpp from Settings or set the model path.');
      }
      const languageProblem = whisperLanguageProblem(cfg.modelPath, language);
      if (languageProblem) throw new Error(languageProblem);
      const outPrefix = path.join(path.dirname(audioPath), 'whisper-out');
      const args = buildWhisperArgs(cfg, audioPath, language, outPrefix);

      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('Transcription was cancelled.'));
          return;
        }
        const child = spawn(cfg.binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const onAbort = () => child.kill();
        signal?.addEventListener('abort', onAbort, { once: true });
        let tail = '';
        const feed = (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          tail = (tail + text).slice(-4000);
          for (const line of text.split(/\r?\n/)) {
            const m = /progress\s*=\s*(\d+)%/.exec(line);
            if (m) onProgress(Math.min(99, Number(m[1])));
          }
        };
        child.stdout.on('data', feed);
        child.stderr.on('data', feed);
        child.on('error', (err) => {
          signal?.removeEventListener('abort', onAbort);
          reject(new Error(`Could not run whisper-cli: ${err.message}`));
        });
        child.on('close', (code) => {
          signal?.removeEventListener('abort', onAbort);
          if (signal?.aborted) reject(new Error('Transcription was cancelled.'));
          else if (code === 0) resolve();
          else reject(new Error(`whisper-cli exited with code ${code}: ${tail.trim().slice(-500)}`));
        });
      });

      const jsonPath = `${outPrefix}.json`;
      if (!fs.existsSync(jsonPath)) {
        throw new Error('whisper-cli finished but produced no JSON output.');
      }
      const parsed = parseWhisperJson(fs.readFileSync(jsonPath, 'utf8'));
      fs.rmSync(jsonPath, { force: true });
      onProgress(100);
      return {
        language: parsed.language,
        engine: 'whisper.cpp',
        segments: parsed.segments,
        vtt: buildVtt(parsed.segments),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible API engine
// ---------------------------------------------------------------------------

export interface OpenAiEngineConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  /** Known audio duration for single-text fallbacks. */
  audioDurationSec: number;
  fetchImpl?: typeof fetch;
}

/** Accepts a base URL or the full /v1/audio/transcriptions URL. */
export function normalizeTranscriptionEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  if (/\/audio\/transcriptions$/.test(trimmed)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/audio/transcriptions`;
  return `${trimmed}/v1/audio/transcriptions`;
}

/** OpenAI-compatible endpoints reject uploads over 25 MB. */
export const API_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;

/** MIME type for the multipart upload, by audio file extension. */
export function audioMimeType(audioPath: string): string {
  switch (path.extname(audioPath).toLowerCase()) {
    case '.mp3':
      return 'audio/mpeg';
    case '.ogg':
    case '.opus':
      return 'audio/ogg';
    case '.m4a':
      return 'audio/mp4';
    default:
      return 'audio/wav';
  }
}

/**
 * Plain-language message when the extracted audio is too large for the API
 * engine, or null when it fits. Says what to do instead of passing through the
 * provider's eventual 413.
 */
export function describeOversizedUpload(sizeBytes: number, durationSec: number): string | null {
  if (sizeBytes <= API_UPLOAD_LIMIT_BYTES) return null;
  const minutes = Math.max(1, Math.round(durationSec / 60));
  const fitsMinutes = Math.max(1, Math.floor((durationSec * API_UPLOAD_LIMIT_BYTES) / sizeBytes / 60));
  return `This recording is about ${minutes} minutes long and its audio comes to ${Math.round(sizeBytes / 1024 / 1024)} MB, but the transcription endpoint accepts uploads up to 25 MB (roughly ${fitsMinutes} minutes at this quality). Use the whisper.cpp engine for long recordings, or trim the video first.`;
}

export function createOpenAiEngine(cfg: OpenAiEngineConfig): TranscriptionProvider {
  const doFetch = cfg.fetchImpl ?? fetch;
  return {
    engine: 'openai',
    async transcribe(audioPath, language, onProgress, signal): Promise<TranscriptResult> {
      if (!cfg.endpoint.trim()) {
        throw new Error('Set the transcription endpoint URL in Settings first.');
      }
      const url = normalizeTranscriptionEndpoint(cfg.endpoint);
      const audio = fs.readFileSync(audioPath);
      const oversized = describeOversizedUpload(audio.byteLength, cfg.audioDurationSec);
      if (oversized) throw new Error(oversized);
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(audio)], { type: audioMimeType(audioPath) }), path.basename(audioPath));
      form.set('model', cfg.model || 'whisper-1');
      form.set('response_format', 'verbose_json');
      if (language && language !== 'auto') form.set('language', language);

      // Plain fetch gives no upload progress, so the notes are honest phases
      // rather than an invented percentage climb.
      onProgress(15, 'Uploading audio');
      const headers: Record<string, string> = {};
      if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
      let res: Response;
      try {
        res = await doFetch(url, { method: 'POST', headers, body: form, signal });
      } catch (err) {
        if (signal?.aborted) throw new Error('Transcription was cancelled.');
        throw new Error(
          `Could not reach the transcription endpoint (${url}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
      onProgress(80, 'Waiting for the transcription service');
      const body = await res.text();
      if (!res.ok) {
        throw new Error(`The transcription endpoint returned ${res.status}: ${body.slice(0, 300)}`);
      }
      const parsed = parseOpenAiTranscription(body, cfg.audioDurationSec);
      onProgress(100);
      return {
        language: parsed.language,
        engine: 'api',
        segments: parsed.segments,
        vtt: buildVtt(parsed.segments),
      };
    },
  };
}

/**
 * A minimal 16kHz mono PCM WAV of silence, built in memory for the Settings
 * "Test connection" probe (no ffmpeg or temp file needed).
 */
export function buildSilentWav(durationSec: number): Buffer {
  const sampleRate = 16000;
  const samples = Math.max(1, Math.round(durationSec * sampleRate));
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

/**
 * Settings "Test connection" for the API engine: posts one second of silence
 * to the configured endpoint and reports pass/fail. Mirrors ai-core's
 * testConnection so the transcription pane can verify its config before a
 * real recording depends on it.
 */
export async function testTranscriptionEndpoint(
  cfg: Pick<OpenAiEngineConfig, 'endpoint' | 'apiKey' | 'model' | 'fetchImpl'>
): Promise<{ ok: boolean; error?: string }> {
  const doFetch = cfg.fetchImpl ?? fetch;
  if (!cfg.endpoint.trim()) {
    return { ok: false, error: 'Set the transcription endpoint URL in Settings first.' };
  }
  const url = normalizeTranscriptionEndpoint(cfg.endpoint);
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(buildSilentWav(1))], { type: 'audio/wav' }), 'test.wav');
  form.set('model', cfg.model || 'whisper-1');
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await doFetch(url, { method: 'POST', headers, body: form, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      return { ok: false, error: `The transcription endpoint returned ${res.status}: ${body}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Could not reach the transcription endpoint (${url}): ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Engine-agnostic pipeline
// ---------------------------------------------------------------------------

export interface TranscribePipelineInput {
  provider: TranscriptionProvider;
  audioPath: string;
  language: string;
  /** Directory where transcript.vtt + transcript.json are written. */
  outDir: string;
  onProgress?: (pct: number) => void;
}

export interface TranscriptFileShape {
  language: string;
  engine: string;
  segments: TranscriptSegment[];
}

/** Run the engine and persist transcript.vtt + transcript.json. */
export async function runTranscriptionPipeline(input: TranscribePipelineInput): Promise<TranscriptResult> {
  const result = await input.provider.transcribe(input.audioPath, input.language, input.onProgress ?? (() => undefined));
  if (result.segments.length === 0) {
    throw new Error('No speech was detected in this recording, so there is nothing to transcribe.');
  }
  fs.mkdirSync(input.outDir, { recursive: true });
  const fileShape: TranscriptFileShape = {
    language: result.language,
    engine: result.engine,
    segments: result.segments,
  };
  fs.writeFileSync(path.join(input.outDir, 'transcript.vtt'), result.vtt);
  fs.writeFileSync(path.join(input.outDir, 'transcript.json'), JSON.stringify(fileShape, null, 2));
  return result;
}
