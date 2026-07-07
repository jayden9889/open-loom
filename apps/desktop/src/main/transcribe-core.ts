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
    async transcribe(audioPath, language, onProgress): Promise<TranscriptResult> {
      if (!fs.existsSync(cfg.binaryPath)) {
        throw new Error('whisper-cli was not found. Install whisper.cpp from Settings or set its path.');
      }
      if (!fs.existsSync(cfg.modelPath)) {
        throw new Error('The whisper model file was not found. Install whisper.cpp from Settings or set the model path.');
      }
      const outPrefix = path.join(path.dirname(audioPath), 'whisper-out');
      const args = buildWhisperArgs(cfg, audioPath, language, outPrefix);

      await new Promise<void>((resolve, reject) => {
        const child = spawn(cfg.binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
        child.on('error', (err) => reject(new Error(`Could not run whisper-cli: ${err.message}`)));
        child.on('close', (code) => {
          if (code === 0) resolve();
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

export function createOpenAiEngine(cfg: OpenAiEngineConfig): TranscriptionProvider {
  const doFetch = cfg.fetchImpl ?? fetch;
  return {
    engine: 'openai',
    async transcribe(audioPath, language, onProgress): Promise<TranscriptResult> {
      if (!cfg.endpoint.trim()) {
        throw new Error('Set the transcription endpoint URL in Settings first.');
      }
      const url = normalizeTranscriptionEndpoint(cfg.endpoint);
      const audio = fs.readFileSync(audioPath);
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), path.basename(audioPath));
      form.set('model', cfg.model || 'whisper-1');
      form.set('response_format', 'verbose_json');
      if (language && language !== 'auto') form.set('language', language);

      onProgress(15);
      const headers: Record<string, string> = {};
      if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
      let res: Response;
      try {
        res = await doFetch(url, { method: 'POST', headers, body: form });
      } catch (err) {
        throw new Error(
          `Could not reach the transcription endpoint (${url}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
      onProgress(80);
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
