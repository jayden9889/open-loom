/**
 * Transcription binding (SPEC T1-T3): resolves the configured engine from
 * settings, extracts 16kHz mono audio via ffmpeg, runs the engine through the
 * shared job queue (progress lands in onJobProgress), stores transcript.vtt +
 * transcript.json next to the video, and offers the guided whisper.cpp
 * installer (scripts/setup-whisper.sh with a live log).
 */
import { app } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TranscriptionProvider } from '@shared/types';
import { VIDEO_FILES } from '@shared/types';
import { getSettings, getSecret, setSettings } from './settings';
import { library } from './library';
import * as ffmpeg from './ffmpeg';
import { createOpenAiEngine, createWhisperEngine, runTranscriptionPipeline } from './transcribe-core';
import { log } from './logger';
import { maybeAutoGenerateAI } from './ai';
import { syncShareCaptions } from './share';

// ---------------------------------------------------------------------------
// whisper.cpp discovery
// ---------------------------------------------------------------------------

const whisperExe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';

/** Default install root used by installWhisper / scripts/setup-whisper.sh. */
export function whisperInstallDir(): string {
  return path.join(app.getPath('userData'), 'whisper');
}

function firstExisting(candidates: string[]): string {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return '';
}

export function resolveWhisperBinary(): string {
  const configured = getSettings().transcription.whisperPath;
  if (configured && fs.existsSync(configured)) return configured;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, whisperExe))) return path.join(dir, whisperExe);
  }
  const root = whisperInstallDir();
  return firstExisting([
    path.join(root, 'whisper.cpp', 'build', 'bin', whisperExe),
    path.join(root, 'whisper.cpp', whisperExe),
    path.join(root, 'whisper.cpp', 'main'),
  ]);
}

export function resolveWhisperModel(): string {
  const configured = getSettings().transcription.whisperModelPath;
  if (configured && fs.existsSync(configured)) return configured;
  const root = whisperInstallDir();
  return firstExisting([
    path.join(root, 'models', 'ggml-base.en.bin'),
    path.join(root, 'whisper.cpp', 'models', 'ggml-base.en.bin'),
  ]);
}

// ---------------------------------------------------------------------------
// Engine resolution
// ---------------------------------------------------------------------------

function buildProvider(audioDurationSec: number): TranscriptionProvider {
  const cfg = getSettings().transcription;
  if (cfg.engine === 'off') {
    throw new Error('Transcription is turned off. Pick an engine in Settings, then try again.');
  }
  if (cfg.engine === 'whisper') {
    const binaryPath = resolveWhisperBinary();
    const modelPath = resolveWhisperModel();
    if (!binaryPath) {
      throw new Error('whisper-cli was not found. Use Install whisper.cpp in Settings, or set its path there.');
    }
    if (!modelPath) {
      throw new Error('No whisper model found. Use Install whisper.cpp in Settings, or set the model path there.');
    }
    return createWhisperEngine({ binaryPath, modelPath });
  }
  return createOpenAiEngine({
    endpoint: cfg.endpoint,
    apiKey: getSecret('transcription.apiKey'),
    model: cfg.model || 'whisper-1',
    audioDurationSec,
  });
}

// ---------------------------------------------------------------------------
// Transcribe a library video (SPEC T1)
// ---------------------------------------------------------------------------

const inFlight = new Set<string>();

export async function transcribeVideo(id: string): Promise<void> {
  const store = library();
  const meta = store.get(id);
  if (inFlight.has(id)) {
    throw new Error('This video is already being transcribed.');
  }
  const bins = ffmpeg.requireBinaries();
  const videoPath = path.join(store.videoDir(id), VIDEO_FILES.video);
  if (!fs.existsSync(videoPath)) {
    throw new Error('The video file for this recording is missing, so it cannot be transcribed.');
  }
  const provider = buildProvider(meta.durationSec);

  inFlight.add(id);
  try {
    await ffmpeg.enqueueJob(id, 'transcribe', async (report) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openloom-transcribe-'));
      try {
        report(2, 'Extracting audio');
        const wavPath = path.join(tempDir, 'audio.wav');
        await ffmpeg.extractAudioWav(bins, videoPath, wavPath);
        report(8, 'Transcribing');
        const engineNote = provider.engine === 'whisper' ? 'Transcribing with whisper.cpp' : 'Transcribing via API';
        const result = await runTranscriptionPipeline({
          provider,
          audioPath: wavPath,
          language: getSettings().transcription.language || 'auto',
          outDir: store.videoDir(id),
          onProgress: (pct) => report(8 + Math.round(pct * 0.9), engineNote),
        });
        store.update(id, { transcript: { language: result.language, engine: result.engine } });
        report(100, 'Transcript ready');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  } finally {
    inFlight.delete(id);
  }

  // Captions land after auto-share on stop has already uploaded, so push the
  // fresh track to the live share copy (no-op when the video is not shared).
  void syncShareCaptions(id).catch((err) => log.warn(`caption share sync failed: ${String(err)}`));

  // Chain AI generation when configured (SPEC A1 auto-run after transcription).
  void maybeAutoGenerateAI(id).catch((err) => log.warn(`auto AI after transcription failed: ${String(err)}`));
}

/** Auto-transcribe hook, called after a recording finishes processing (SPEC T1). */
export function maybeAutoTranscribe(videoId: string): void {
  const cfg = getSettings().transcription;
  if (!cfg.auto || cfg.engine === 'off') return;
  void transcribeVideo(videoId).catch((err) =>
    log.warn(`auto-transcribe for ${videoId} failed: ${err instanceof Error ? err.message : String(err)}`)
  );
}

// ---------------------------------------------------------------------------
// Guided whisper.cpp install (SPEC G4): runs scripts/setup-whisper.sh with a
// live log streamed to onSetupLog, then points settings at the result.
// ---------------------------------------------------------------------------

let installing: Promise<void> | null = null;

export function installWhisper(onLine: (line: string) => void): Promise<void> {
  if (process.platform === 'win32') {
    return Promise.reject(
      new Error(
        'The guided whisper.cpp build needs a Unix shell and is macOS/Linux only for now. On Windows, download a whisper.cpp release, then set the whisper-cli and model paths in Settings.'
      )
    );
  }
  if (installing) {
    onLine('An install is already running.');
    return installing;
  }
  const inTree = path.resolve(app.getAppPath(), '../../scripts/setup-whisper.sh');
  const packaged = path.resolve(app.getAppPath(), 'scripts/setup-whisper.sh');
  const scriptPath = fs.existsSync(inTree) ? inTree : packaged;
  if (!fs.existsSync(scriptPath)) {
    return Promise.reject(
      new Error(
        'The whisper.cpp setup script is missing from this install. Build whisper.cpp manually and set its paths in Settings.'
      )
    );
  }
  const dest = whisperInstallDir();
  fs.mkdirSync(dest, { recursive: true });

  installing = new Promise<void>((resolve, reject) => {
    let binPath = '';
    let modelPath = '';
    const child = spawn('bash', [scriptPath, '--dest', dest], { stdio: ['ignore', 'pipe', 'pipe'] });
    const feed = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const bin = /^OPENLOOM_WHISPER_BIN=(.+)$/.exec(trimmed);
        const model = /^OPENLOOM_WHISPER_MODEL=(.+)$/.exec(trimmed);
        if (bin) binPath = bin[1]!;
        if (model) modelPath = model[1]!;
        onLine(trimmed);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (err) => {
      installing = null;
      reject(new Error(`Could not run the setup script: ${err.message}`));
    });
    child.on('close', (code) => {
      installing = null;
      if (code === 0 && binPath && modelPath && fs.existsSync(binPath) && fs.existsSync(modelPath)) {
        setSettings({
          transcription: {
            ...getSettings().transcription,
            engine: 'whisper',
            whisperPath: binPath,
            whisperModelPath: modelPath,
          },
        });
        onLine('whisper.cpp is installed and selected as the transcription engine.');
        resolve();
      } else if (code === 0) {
        reject(new Error('The setup script finished but did not report usable paths. Check the log above.'));
      } else {
        reject(
          new Error(
            `The whisper.cpp install failed (exit code ${code}). The most common causes are missing build tools (Xcode Command Line Tools or cmake/make) and no network access. Check the log above.`
          )
        );
      }
    });
  });
  return installing;
}
