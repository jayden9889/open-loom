/**
 * Transcription pipeline tests (SPEC T1): VTT round-trip, whisper.cpp JSON
 * parsing, OpenAI-compatible response parsing, the file-writing pipeline with
 * a stub engine, and - when a local whisper.cpp install plus the macOS `say`
 * synthesiser are available - a real end-to-end whisper transcription.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TranscriptResult, TranscriptSegment, TranscriptionProvider } from '@shared/types';
import {
  buildVtt,
  buildWhisperArgs,
  cleanSegments,
  createOpenAiEngine,
  createWhisperEngine,
  formatVttTime,
  normalizeTranscriptionEndpoint,
  parseOpenAiTranscription,
  parseVttTime,
  parseVttToSegments,
  parseWhisperJson,
  runTranscriptionPipeline,
} from '../transcribe-core';
import { resolveBinaries, extractAudioWav } from '../ffmpeg-core';

const SEGMENTS: TranscriptSegment[] = [
  { start: 0, end: 2.5, text: 'Welcome to the demo.' },
  { start: 2.5, end: 5.75, text: 'First we open the settings.' },
  { start: 61.2, end: 65.001, text: 'Then we record the screen.' },
];

describe('VTT round-trip', () => {
  it('formats and parses times', () => {
    expect(formatVttTime(0)).toBe('00:00:00.000');
    expect(formatVttTime(65.25)).toBe('00:01:05.250');
    expect(formatVttTime(3661.5)).toBe('01:01:01.500');
    expect(parseVttTime('00:01:05.250')).toBeCloseTo(65.25, 3);
    expect(parseVttTime('01:05,250')).toBeCloseTo(65.25, 3);
  });

  it('round-trips segments through WEBVTT text', () => {
    const vtt = buildVtt(SEGMENTS);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    const back = parseVttToSegments(vtt);
    expect(back).toHaveLength(SEGMENTS.length);
    back.forEach((seg, i) => {
      expect(seg.start).toBeCloseTo(SEGMENTS[i]!.start, 2);
      expect(seg.end).toBeCloseTo(SEGMENTS[i]!.end, 2);
      expect(seg.text).toBe(SEGMENTS[i]!.text);
    });
  });

  it('ignores malformed blocks and strips tags', () => {
    const messy = 'WEBVTT\n\nnot a cue\n\n1\n00:00.000 --> 00:02.000\n<b>Hello</b> there\n';
    const segs = parseVttToSegments(messy);
    expect(segs).toEqual([{ start: 0, end: 2, text: 'Hello there' }]);
  });
});

describe('cleanSegments', () => {
  it('drops empties, clamps negatives and sorts', () => {
    const out = cleanSegments([
      { start: 5, end: 6, text: 'b' },
      { start: -1, end: 2, text: ' a ' },
      { start: 3, end: 2.5, text: 'c' },
      { start: 0, end: 1, text: '   ' },
    ]);
    expect(out).toEqual([
      { start: 0, end: 2, text: 'a' },
      { start: 3, end: 3, text: 'c' },
      { start: 5, end: 6, text: 'b' },
    ]);
  });
});

describe('whisper.cpp JSON parsing', () => {
  it('reads the real output-json shape (offsets in ms + result.language)', () => {
    const raw = JSON.stringify({
      systeminfo: 'NEON = 1',
      result: { language: 'en' },
      transcription: [
        { timestamps: { from: '00:00:00,000', to: '00:00:05,220' }, offsets: { from: 0, to: 5220 }, text: ' Welcome to the demo.' },
        { offsets: { from: 5220, to: 8000 }, text: ' Second line. ' },
      ],
    });
    const parsed = parseWhisperJson(raw);
    expect(parsed.language).toBe('en');
    expect(parsed.segments).toEqual([
      { start: 0, end: 5.22, text: 'Welcome to the demo.' },
      { start: 5.22, end: 8, text: 'Second line.' },
    ]);
  });

  it('builds version-stable short-flag args', () => {
    const args = buildWhisperArgs({ binaryPath: '/x/whisper-cli', modelPath: '/x/model.bin' }, '/tmp/a.wav', 'en', '/tmp/out');
    expect(args).toEqual(['-m', '/x/model.bin', '-f', '/tmp/a.wav', '-oj', '-of', '/tmp/out', '-pp', '-np', '-l', 'en']);
    const auto = buildWhisperArgs({ binaryPath: '/x/w', modelPath: '/x/m' }, '/a.wav', 'auto', '/o');
    expect(auto).toContain('auto');
  });
});

describe('OpenAI-compatible parsing', () => {
  it('uses verbose_json segments when present', () => {
    const parsed = parseOpenAiTranscription(
      JSON.stringify({ language: 'english', segments: [{ start: 0, end: 3.2, text: ' Hi there ' }] }),
      99
    );
    expect(parsed.language).toBe('english');
    expect(parsed.segments).toEqual([{ start: 0, end: 3.2, text: 'Hi there' }]);
  });

  it('falls back to a single segment for text-only responses', () => {
    const parsed = parseOpenAiTranscription(JSON.stringify({ text: 'Just text.' }), 12.5);
    expect(parsed.segments).toEqual([{ start: 0, end: 12.5, text: 'Just text.' }]);
  });

  it('normalises endpoint URLs', () => {
    expect(normalizeTranscriptionEndpoint('https://x.test')).toBe('https://x.test/v1/audio/transcriptions');
    expect(normalizeTranscriptionEndpoint('https://x.test/v1/')).toBe('https://x.test/v1/audio/transcriptions');
    expect(normalizeTranscriptionEndpoint('https://x.test/v1/audio/transcriptions')).toBe(
      'https://x.test/v1/audio/transcriptions'
    );
  });

  it('posts multipart form data and parses the response via the engine', async () => {
    let captured: { url: string; hasAuth: boolean; model: string | null } | null = null;
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      captured = {
        url: String(url),
        hasAuth: Boolean((init?.headers as Record<string, string>)['Authorization']),
        model: (form.get('model') as string) ?? null,
      };
      return new Response(JSON.stringify({ language: 'en', segments: [{ start: 0, end: 1, text: 'ok' }] }), {
        status: 200,
      });
    }) as typeof fetch;

    const wav = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ol-t-')), 'a.wav');
    fs.writeFileSync(wav, Buffer.from('RIFF0000WAVE'));
    const engine = createOpenAiEngine({
      endpoint: 'https://api.example.test/v1',
      apiKey: 'k',
      model: 'whisper-large',
      audioDurationSec: 1,
      fetchImpl,
    });
    const result = await engine.transcribe(wav, 'auto', () => undefined);
    expect(result.segments[0]!.text).toBe('ok');
    expect(captured).toEqual({
      url: 'https://api.example.test/v1/audio/transcriptions',
      hasAuth: true,
      model: 'whisper-large',
    });
  });

  it('surfaces HTTP errors with a human message', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    const wav = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ol-t-')), 'a.wav');
    fs.writeFileSync(wav, Buffer.from('x'));
    const engine = createOpenAiEngine({
      endpoint: 'https://api.example.test',
      apiKey: '',
      model: 'whisper-1',
      audioDurationSec: 1,
      fetchImpl,
    });
    await expect(engine.transcribe(wav, 'auto', () => undefined)).rejects.toThrow(/401/);
  });
});

describe('pipeline with a stub engine', () => {
  const stub = (segments: TranscriptSegment[]): TranscriptionProvider => ({
    engine: 'whisper',
    async transcribe(): Promise<TranscriptResult> {
      return { language: 'en', engine: 'stub', segments, vtt: buildVtt(segments) };
    },
  });

  it('writes transcript.vtt and transcript.json next to the video', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-pipe-'));
    const result = await runTranscriptionPipeline({
      provider: stub(SEGMENTS),
      audioPath: '/unused.wav',
      language: 'auto',
      outDir,
    });
    expect(result.segments).toHaveLength(3);
    const vtt = fs.readFileSync(path.join(outDir, 'transcript.vtt'), 'utf8');
    expect(vtt).toContain('Welcome to the demo.');
    const json = JSON.parse(fs.readFileSync(path.join(outDir, 'transcript.json'), 'utf8')) as {
      language: string;
      engine: string;
      segments: TranscriptSegment[];
    };
    expect(json.language).toBe('en');
    expect(json.engine).toBe('stub');
    expect(json.segments).toHaveLength(3);
  });

  it('fails with a human message when no speech is found', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-pipe-'));
    await expect(
      runTranscriptionPipeline({ provider: stub([]), audioPath: '/unused.wav', language: 'auto', outDir })
    ).rejects.toThrow(/No speech/);
  });
});

// ---------------------------------------------------------------------------
// Real whisper.cpp end-to-end (runs only when a local install + `say` exist)
// ---------------------------------------------------------------------------

function findLocalWhisper(): { bin: string; model: string } | null {
  const roots =
    process.platform === 'darwin'
      ? [path.join(os.homedir(), 'Library', 'Application Support', 'OpenLoom', 'whisper')]
      : [path.join(process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share'), 'OpenLoom', 'whisper')];
  for (const root of roots) {
    const model = path.join(root, 'models', 'ggml-base.en.bin');
    for (const bin of [
      path.join(root, 'whisper.cpp', 'build', 'bin', 'whisper-cli'),
      path.join(root, 'whisper.cpp', 'main'),
    ]) {
      if (fs.existsSync(bin) && fs.existsSync(model)) return { bin, model };
    }
  }
  return null;
}

const localWhisper = findLocalWhisper();
const canSynthesise = process.platform === 'darwin' && fs.existsSync('/usr/bin/say');
const bins = resolveBinaries('', path.join(os.tmpdir(), 'nonexistent-bin-dir'));

describe.skipIf(!localWhisper || !canSynthesise || !bins)('real whisper.cpp end-to-end', () => {
  it('transcribes synthesised speech through the full pipeline', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-whisper-e2e-'));
    const aiff = path.join(work, 'speech.aiff');
    execFileSync('say', ['-o', aiff, 'Welcome to the open loom demo. This sentence tests transcription.']);
    const wav = path.join(work, 'speech.wav');
    await extractAudioWav(bins!, aiff, wav);

    const engine = createWhisperEngine({ binaryPath: localWhisper!.bin, modelPath: localWhisper!.model });
    const progress: number[] = [];
    const result = await runTranscriptionPipeline({
      provider: engine,
      audioPath: wav,
      language: 'en',
      outDir: work,
      onProgress: (p) => progress.push(p),
    });

    const text = result.segments.map((s) => s.text).join(' ').toLowerCase();
    expect(text).toContain('demo');
    expect(text).toContain('transcription');
    expect(result.language).toBe('en');
    expect(progress[progress.length - 1]).toBe(100);
    expect(fs.existsSync(path.join(work, 'transcript.vtt'))).toBe(true);
    expect(fs.existsSync(path.join(work, 'transcript.json'))).toBe(true);
  });
});
