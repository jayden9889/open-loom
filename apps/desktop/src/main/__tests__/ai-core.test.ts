/**
 * AI provider tests (SPEC A1) against a local mock HTTP server that speaks
 * all three wire formats (Anthropic Messages, OpenAI chat completions,
 * Ollama chat), plus JSON extraction and chapter validation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { VideoMeta } from '@shared/types';
import {
  anthropicUrl,
  buildPrompt,
  extractJsonObject,
  generate,
  ollamaChatUrl,
  openAiChatUrl,
  parseGeneration,
  testConnection,
  validateChapters,
} from '../ai-core';

const META: VideoMeta = {
  id: 'testvid001',
  title: 'Recording - 6 Jul 2026, 14:32',
  createdAt: '2026-07-06T14:32:00.000Z',
  durationSec: 120,
  width: 1920,
  height: 1080,
  fps: 30,
  sizeBytes: 1000,
  mode: 'screen',
};

const SEGMENTS = [
  { start: 0, end: 5, text: 'Today I will show the new dashboard.' },
  { start: 60, end: 70, text: 'Remember to update the config file afterwards.' },
];

const GENERATION = {
  title: 'New dashboard walkthrough',
  summary: 'A quick tour of the dashboard and its setup steps.',
  chapters: [
    { t: 0, title: 'Intro' },
    { t: 60, title: 'Configuration' },
    { t: 500, title: 'Beyond the end' },
  ],
  tasks: ['Update the config file'],
};

let server: http.Server;
let base: string;
let lastRequest: { url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> } | null = null;
let failNext = false;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      lastRequest = { url: req.url ?? '', headers: req.headers, body };
      if (failNext) {
        failNext = false;
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      }
      const text = '```json\n' + JSON.stringify(GENERATION) + '\n```';
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/v1/messages') {
        res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
      } else if (req.url === '/v1/chat/completions') {
        res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
      } else if (req.url === '/api/chat') {
        res.end(JSON.stringify({ message: { content: text } }));
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe('endpoint shaping', () => {
  it('builds provider URLs from base endpoints', () => {
    expect(anthropicUrl('')).toBe('https://api.anthropic.com/v1/messages');
    expect(anthropicUrl('https://proxy.test/')).toBe('https://proxy.test/v1/messages');
    expect(openAiChatUrl('https://x.test/v1')).toBe('https://x.test/v1/chat/completions');
    expect(openAiChatUrl('https://x.test')).toBe('https://x.test/v1/chat/completions');
    expect(openAiChatUrl('https://x.test/v1/chat/completions')).toBe('https://x.test/v1/chat/completions');
    expect(() => openAiChatUrl('')).toThrow(/endpoint/i);
    expect(ollamaChatUrl('')).toBe('http://localhost:11434/api/chat');
    expect(ollamaChatUrl('http://box:11434/')).toBe('http://box:11434/api/chat');
  });
});

describe('prompt building', () => {
  it('includes timestamps, duration bound and only the requested keys', () => {
    const prompt = buildPrompt(META, SEGMENTS, ['chapters', 'tasks']);
    expect(prompt).toContain('[0:00] Today I will show the new dashboard.');
    expect(prompt).toContain('[1:00] Remember to update the config file afterwards.');
    expect(prompt).toContain('between 0 and 120');
    expect(prompt).toContain('"chapters"');
    expect(prompt).toContain('"tasks"');
    expect(prompt).not.toContain('"summary"');
  });
});

describe('response parsing + validation', () => {
  it('extracts JSON from fenced and prosey responses', () => {
    expect(extractJsonObject('Sure!\n```json\n{"a": 1}\n```\nDone.')).toEqual({ a: 1 });
    expect(extractJsonObject('{"a": {"b": "with } brace in string"}}')).toEqual({ a: { b: 'with } brace in string' } });
    expect(() => extractJsonObject('no json here')).toThrow(/JSON/);
  });

  it('validates chapters against duration, sorts and de-duplicates', () => {
    const chapters = validateChapters(
      [
        { t: 90, title: 'Late' },
        { t: 0, title: 'Start' },
        { t: 0.4, title: 'Duplicate of start' },
        { t: 500, title: 'Past the end' },
        { t: 'x', title: 'Bad time' },
        { t: 10 },
      ],
      120
    );
    expect(chapters).toEqual([
      { t: 0, title: 'Start' },
      { t: 90, title: 'Late' },
    ]);
  });

  it('keeps only requested kinds', () => {
    const parsed = parseGeneration(JSON.stringify(GENERATION), ['summary'], 120);
    expect(parsed.summary).toBe(GENERATION.summary);
    expect(parsed.title).toBeUndefined();
    expect(parsed.chapters).toBeUndefined();
  });
});

describe('providers against the mock server', () => {
  it('anthropic: sends x-api-key + version header and parses content blocks', async () => {
    const result = await generate(
      { provider: 'anthropic', endpoint: base, model: 'claude-test', apiKey: 'secret-key' },
      META,
      SEGMENTS,
      ['title', 'summary', 'chapters', 'tasks']
    );
    expect(lastRequest?.url).toBe('/v1/messages');
    expect(lastRequest?.headers['x-api-key']).toBe('secret-key');
    expect(lastRequest?.headers['anthropic-version']).toBe('2023-06-01');
    expect(lastRequest?.body['model']).toBe('claude-test');
    expect(result.title).toBe(GENERATION.title);
    expect(result.summary).toBe(GENERATION.summary);
    // The out-of-range chapter is dropped by validation.
    expect(result.chapters).toEqual([
      { t: 0, title: 'Intro' },
      { t: 60, title: 'Configuration' },
    ]);
    expect(result.tasks).toEqual(GENERATION.tasks);
  });

  it('openai-compatible: bearer auth on /chat/completions', async () => {
    const result = await generate(
      { provider: 'openai', endpoint: `${base}/v1`, model: 'gpt-test', apiKey: 'tok' },
      META,
      SEGMENTS,
      ['title']
    );
    expect(lastRequest?.url).toBe('/v1/chat/completions');
    expect(lastRequest?.headers['authorization']).toBe('Bearer tok');
    expect(result.title).toBe(GENERATION.title);
  });

  it('ollama: keyless local chat with stream disabled', async () => {
    const result = await generate(
      { provider: 'ollama', endpoint: base, model: 'llama-test', apiKey: '' },
      META,
      SEGMENTS,
      ['tasks']
    );
    expect(lastRequest?.url).toBe('/api/chat');
    expect(lastRequest?.headers['authorization']).toBeUndefined();
    expect(lastRequest?.body['stream']).toBe(false);
    expect(result.tasks).toEqual(GENERATION.tasks);
  });

  it('requires a model name', async () => {
    await expect(
      generate({ provider: 'ollama', endpoint: base, model: '', apiKey: '' }, META, SEGMENTS, ['title'])
    ).rejects.toThrow(/model/i);
  });

  it('testConnection reports ok and failures', async () => {
    const ok = await testConnection({ provider: 'openai', endpoint: base, model: 'gpt-test', apiKey: 'k' });
    expect(ok.ok).toBe(true);
    failNext = true;
    const bad = await testConnection({ provider: 'openai', endpoint: base, model: 'gpt-test', apiKey: 'k' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/500/);
    const unreachable = await testConnection({
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:9',
      model: 'x',
      apiKey: '',
    });
    expect(unreachable.ok).toBe(false);
  });
});
