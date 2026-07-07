/**
 * Server-rendered watch page (SPEC V2, D-series design language).
 * Fully self-contained: inline CSS + vanilla JS, zero external requests.
 * Light + dark via prefers-color-scheme with a [data-theme] override hook.
 */
import { escapeHtml } from '../util.js';

export interface PageChapter {
  t: number;
  title: string;
}

export interface WatchPageData {
  id: string;
  title: string;
  creator: string | null;
  createdAt: string;
  durationSec: number;
  allowComments: boolean;
  allowReactions: boolean;
  allowDownload: boolean;
  cta: { label: string; url: string } | null;
  chapters: PageChapter[];
  hasCaptions: boolean;
  hasThumb: boolean;
  reactions: Record<string, number>;
  embed: boolean;
}

const CSS = `
:root {
  --ol-font: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --ol-accent: #635bff;
  --ol-accent-hover: #574edb;
  --ol-accent-soft: rgba(99, 91, 255, 0.12);
  --ol-danger: #ff453a;
  --ol-radius-card: 12px;
  --ol-radius-control: 8px;
  --ol-ease: cubic-bezier(0.32, 0.72, 0.24, 1);
  --ol-bg: #f5f5f7;
  --ol-surface: #ffffff;
  --ol-surface-2: #fafafa;
  --ol-text: #1d1d1f;
  --ol-text-secondary: #6e6e73;
  --ol-text-tertiary: #aeaeb2;
  --ol-border: rgba(0, 0, 0, 0.1);
  --ol-border-strong: rgba(0, 0, 0, 0.18);
  --ol-hover: rgba(0, 0, 0, 0.045);
  --ol-elev-card: 0 1px 3px rgba(0, 0, 0, 0.08);
  --ol-on-accent: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ol-bg: #1d1d1f; --ol-surface: #2c2c2e; --ol-surface-2: #242426;
    --ol-text: #f5f5f7; --ol-text-secondary: #98989d; --ol-text-tertiary: #636366;
    --ol-border: rgba(255, 255, 255, 0.12); --ol-border-strong: rgba(255, 255, 255, 0.22);
    --ol-hover: rgba(255, 255, 255, 0.06); --ol-elev-card: 0 1px 3px rgba(0, 0, 0, 0.3);
    --ol-accent-soft: rgba(99, 91, 255, 0.22);
  }
}
:root[data-theme='light'] {
  --ol-bg: #f5f5f7; --ol-surface: #ffffff; --ol-surface-2: #fafafa;
  --ol-text: #1d1d1f; --ol-text-secondary: #6e6e73; --ol-text-tertiary: #aeaeb2;
  --ol-border: rgba(0, 0, 0, 0.1); --ol-border-strong: rgba(0, 0, 0, 0.18);
  --ol-hover: rgba(0, 0, 0, 0.045); --ol-elev-card: 0 1px 3px rgba(0, 0, 0, 0.08);
  --ol-accent-soft: rgba(99, 91, 255, 0.12);
}
:root[data-theme='dark'] {
  --ol-bg: #1d1d1f; --ol-surface: #2c2c2e; --ol-surface-2: #242426;
  --ol-text: #f5f5f7; --ol-text-secondary: #98989d; --ol-text-tertiary: #636366;
  --ol-border: rgba(255, 255, 255, 0.12); --ol-border-strong: rgba(255, 255, 255, 0.22);
  --ol-hover: rgba(255, 255, 255, 0.06); --ol-elev-card: 0 1px 3px rgba(0, 0, 0, 0.3);
  --ol-accent-soft: rgba(99, 91, 255, 0.22);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  font-family: var(--ol-font); background: var(--ol-bg); color: var(--ol-text);
  font-size: 14px; line-height: 1.45; -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
button:focus-visible, input:focus-visible, textarea:focus-visible, a:focus-visible {
  outline: 2px solid var(--ol-accent); outline-offset: 2px; border-radius: 4px;
}
input, textarea { font: inherit; color: var(--ol-text); }
a { color: var(--ol-accent); text-decoration: none; }
a:hover { text-decoration: underline; }

.top {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 24px; max-width: 1200px; margin: 0 auto;
}
.brand { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 15px; color: var(--ol-text); }
.brand:hover { text-decoration: none; }
.top-date { color: var(--ol-text-secondary); font-size: 12px; }

.layout { max-width: 1200px; margin: 0 auto; padding: 0 24px 48px; display: grid; gap: 24px; grid-template-columns: 1fr; }
.layout.has-rail { grid-template-columns: minmax(0, 1fr) 320px; }
@media (max-width: 960px) { .layout.has-rail { grid-template-columns: 1fr; } }

.player-card { background: var(--ol-surface); border-radius: var(--ol-radius-card); box-shadow: var(--ol-elev-card); overflow: hidden; border: 1px solid var(--ol-border); }
.video-box { position: relative; background: #000; }
.video-box video { display: block; width: 100%; max-height: 72vh; background: #000; }
.big-play {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: #fff; transition: opacity var(--ol-ease) 180ms;
}
.big-play .disc { width: 72px; height: 72px; border-radius: 999px; background: var(--ol-accent); display: flex; align-items: center; justify-content: center; transition: transform 120ms var(--ol-ease); }
.big-play:hover .disc { transform: scale(1.06); }
.big-play.hidden { opacity: 0; pointer-events: none; }

.controls { display: flex; align-items: center; gap: 4px; padding: 8px 12px; border-top: 1px solid var(--ol-border); background: var(--ol-surface); position: relative; }
.ctrl { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: var(--ol-radius-control); color: var(--ol-text-secondary); }
.ctrl:hover { background: var(--ol-hover); color: var(--ol-text); }
.ctrl.active { color: var(--ol-accent); background: var(--ol-accent-soft); }
.ctrl svg { width: 18px; height: 18px; }
.time { font-variant-numeric: tabular-nums; font-size: 12px; color: var(--ol-text-secondary); padding: 0 6px; white-space: nowrap; }

.scrub { flex: 1; height: 24px; display: flex; align-items: center; cursor: pointer; position: relative; touch-action: none; }
.scrub .track { position: relative; width: 100%; height: 4px; border-radius: 999px; background: var(--ol-border-strong); overflow: visible; }
.scrub .buffered { position: absolute; inset: 0 auto 0 0; border-radius: 999px; background: var(--ol-text-tertiary); opacity: .5; width: 0; }
.scrub .played { position: absolute; inset: 0 auto 0 0; border-radius: 999px; background: var(--ol-accent); width: 0; }
.scrub .knob { position: absolute; top: 50%; width: 12px; height: 12px; border-radius: 999px; background: var(--ol-accent); transform: translate(-50%, -50%) scale(0); transition: transform 120ms var(--ol-ease); }
.scrub:hover .knob, .scrub.dragging .knob { transform: translate(-50%, -50%) scale(1); }
.scrub .tip { position: absolute; bottom: 18px; transform: translateX(-50%); background: var(--ol-text); color: var(--ol-bg); font-size: 11px; padding: 2px 6px; border-radius: 6px; display: none; font-variant-numeric: tabular-nums; }
.scrub:hover .tip { display: block; }

.speed-menu { position: absolute; bottom: 44px; right: 12px; background: var(--ol-surface); border: 1px solid var(--ol-border); border-radius: var(--ol-radius-control); box-shadow: var(--ol-elev-card); padding: 4px; display: none; min-width: 88px; z-index: 20; }
.speed-menu.open { display: block; }
.speed-menu button { display: flex; width: 100%; justify-content: space-between; gap: 12px; padding: 6px 10px; border-radius: 6px; font-size: 13px; }
.speed-menu button:hover { background: var(--ol-hover); }
.speed-menu button.sel { color: var(--ol-accent); font-weight: 600; }
.speed-label { font-size: 12px; font-weight: 600; width: auto; padding: 0 8px; }

.vol { display: flex; align-items: center; }
.vol input[type=range] { width: 0; opacity: 0; transition: width 160ms var(--ol-ease), opacity 160ms; accent-color: var(--ol-accent); }
.vol:hover input[type=range], .vol input[type=range]:focus-visible { width: 72px; opacity: 1; }

.headline { margin-top: 20px; }
.headline h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
.byline { margin-top: 4px; color: var(--ol-text-secondary); font-size: 13px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.byline .dot::before { content: '\\00B7'; }

.action-row { display: flex; align-items: center; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
.reactions { display: flex; gap: 6px; flex-wrap: wrap; }
.react { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--ol-border); background: var(--ol-surface); font-size: 14px; transition: transform 120ms var(--ol-ease); }
.react:hover { background: var(--ol-hover); }
.react:active { transform: scale(0.94); }
.react.mine { border-color: var(--ol-accent); background: var(--ol-accent-soft); }
.react .n { font-size: 12px; color: var(--ol-text-secondary); font-variant-numeric: tabular-nums; }
.react.mine .n { color: var(--ol-accent); font-weight: 600; }
.spacer { flex: 1; }
.btn { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: var(--ol-radius-control); font-weight: 600; font-size: 13px; border: 1px solid var(--ol-border); background: var(--ol-surface); color: var(--ol-text); }
.btn:hover { background: var(--ol-hover); text-decoration: none; }
.btn svg { width: 15px; height: 15px; }
.btn-accent { background: var(--ol-accent); border-color: var(--ol-accent); color: var(--ol-on-accent); }
.btn-accent:hover { background: var(--ol-accent-hover); }

.rail { display: flex; flex-direction: column; gap: 12px; }
.rail-card { background: var(--ol-surface); border: 1px solid var(--ol-border); border-radius: var(--ol-radius-card); box-shadow: var(--ol-elev-card); overflow: hidden; }
.rail-tabs { display: flex; padding: 8px 8px 0; gap: 4px; border-bottom: 1px solid var(--ol-border); }
.rail-tab { padding: 8px 12px; font-size: 13px; font-weight: 600; color: var(--ol-text-secondary); border-bottom: 2px solid transparent; border-radius: 6px 6px 0 0; }
.rail-tab:hover { color: var(--ol-text); }
.rail-tab.sel { color: var(--ol-accent); border-bottom-color: var(--ol-accent); }
.rail-body { max-height: 56vh; overflow-y: auto; padding: 8px; }
.chapter { display: flex; gap: 10px; width: 100%; text-align: left; padding: 8px 10px; border-radius: var(--ol-radius-control); align-items: baseline; }
.chapter:hover { background: var(--ol-hover); }
.chapter.now { background: var(--ol-accent-soft); }
.chapter .t { font-variant-numeric: tabular-nums; color: var(--ol-accent); font-size: 12px; font-weight: 600; min-width: 40px; }
.cue { display: flex; gap: 10px; width: 100%; text-align: left; padding: 6px 10px; border-radius: var(--ol-radius-control); align-items: baseline; font-size: 13px; color: var(--ol-text-secondary); }
.cue:hover { background: var(--ol-hover); color: var(--ol-text); }
.cue.now { background: var(--ol-accent-soft); color: var(--ol-text); }
.cue .t { font-variant-numeric: tabular-nums; color: var(--ol-text-tertiary); font-size: 11px; min-width: 40px; }
.rail-empty { padding: 24px 16px; text-align: center; color: var(--ol-text-secondary); font-size: 13px; }

.comments { margin-top: 32px; }
.comments h2 { font-size: 15px; font-weight: 700; margin-bottom: 12px; }
.comments h2 .n { color: var(--ol-text-secondary); font-weight: 500; }
.c-form { background: var(--ol-surface); border: 1px solid var(--ol-border); border-radius: var(--ol-radius-card); padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.c-form input, .c-form textarea { background: var(--ol-surface-2); border: 1px solid var(--ol-border); border-radius: var(--ol-radius-control); padding: 8px 10px; font-size: 13px; }
.c-form textarea { resize: vertical; min-height: 60px; }
.c-form .row { display: flex; align-items: center; gap: 8px; }
.c-form .row input { flex: 0 0 180px; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 12px; border: 1px solid var(--ol-border); color: var(--ol-text-secondary); font-variant-numeric: tabular-nums; }
.chip.on { border-color: var(--ol-accent); color: var(--ol-accent); background: var(--ol-accent-soft); font-weight: 600; }
.post-btn { margin-left: auto; padding: 7px 16px; border-radius: var(--ol-radius-control); background: var(--ol-accent); color: var(--ol-on-accent); font-weight: 600; font-size: 13px; }
.post-btn:hover { background: var(--ol-accent-hover); }
.post-btn:disabled { opacity: .5; cursor: default; }
.c-list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.c-item { background: var(--ol-surface); border: 1px solid var(--ol-border); border-radius: var(--ol-radius-card); padding: 12px; }
.c-head { display: flex; align-items: center; gap: 8px; }
.avatar { width: 26px; height: 26px; border-radius: 999px; background: var(--ol-accent-soft); color: var(--ol-accent); font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.c-author { font-weight: 600; font-size: 13px; }
.c-when { color: var(--ol-text-tertiary); font-size: 11px; }
.t-chip { font-variant-numeric: tabular-nums; font-size: 11px; font-weight: 700; color: var(--ol-accent); background: var(--ol-accent-soft); border-radius: 999px; padding: 2px 8px; }
.t-chip:hover { background: var(--ol-accent); color: var(--ol-on-accent); }
.c-text { margin-top: 6px; white-space: pre-wrap; word-break: break-word; font-size: 13px; }
.c-actions { margin-top: 6px; }
.c-reply-btn { font-size: 12px; color: var(--ol-text-secondary); font-weight: 600; }
.c-reply-btn:hover { color: var(--ol-accent); }
.c-replies { margin-top: 10px; padding-left: 14px; border-left: 2px solid var(--ol-border); display: flex; flex-direction: column; gap: 10px; }
.c-empty { color: var(--ol-text-secondary); font-size: 13px; padding: 20px 4px; text-align: center; }

.foot { max-width: 1200px; margin: 0 auto; padding: 0 24px 32px; color: var(--ol-text-tertiary); font-size: 12px; }

.center-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
.center-card { background: var(--ol-surface); border: 1px solid var(--ol-border); border-radius: var(--ol-radius-card); box-shadow: var(--ol-elev-card); padding: 40px 36px; max-width: 400px; width: 100%; text-align: center; }
.center-card h1 { font-size: 18px; margin: 14px 0 6px; }
.center-card p { color: var(--ol-text-secondary); font-size: 13px; }
.center-card .glyph { width: 48px; height: 48px; border-radius: 999px; background: var(--ol-accent-soft); color: var(--ol-accent); display: inline-flex; align-items: center; justify-content: center; }
.center-card .glyph svg { width: 22px; height: 22px; }
.center-card form { margin-top: 18px; display: flex; flex-direction: column; gap: 10px; }
.center-card input[type=password] { background: var(--ol-surface-2); border: 1px solid var(--ol-border); border-radius: var(--ol-radius-control); padding: 10px 12px; font-size: 14px; text-align: center; }
.center-card .unlock { padding: 10px; border-radius: var(--ol-radius-control); background: var(--ol-accent); color: var(--ol-on-accent); font-weight: 600; }
.center-card .unlock:hover { background: var(--ol-accent-hover); }
.form-error { color: var(--ol-danger); font-size: 12px; min-height: 16px; }
.spin { width: 28px; height: 28px; border-radius: 999px; border: 3px solid var(--ol-accent-soft); border-top-color: var(--ol-accent); animation: olspin 0.9s linear infinite; margin: 0 auto; }
@keyframes olspin { to { transform: rotate(360deg); } }

body.embed { background: #000; }
body.embed .video-box video { max-height: none; height: calc(100vh - 49px); }
body.embed .player-card { border-radius: 0; border: 0; height: 100vh; display: flex; flex-direction: column; }
body.embed .video-box { flex: 1; }
body.embed .embed-title { position: absolute; top: 10px; left: 12px; background: rgba(0,0,0,0.6); color: #fff; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px; opacity: 0; transition: opacity 180ms var(--ol-ease); pointer-events: none; }
body.embed .video-box:hover .embed-title { opacity: 1; }
`;

const ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a.8.8 0 0 0 1.22.68l10.3-6.5a.8.8 0 0 0 0-1.36L9.22 4.82A.8.8 0 0 0 8 5.5Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2"/></svg>',
  volume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5.5 7 9H4v6h3l4 3.5v-13Z"/><path d="M15 9.5a4 4 0 0 1 0 5"/><path d="M17.5 7a7 7 0 0 1 0 10"/></svg>',
  muted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5.5 7 9H4v6h3l4 3.5v-13Z"/><path d="m15.5 9.5 5 5m0-5-5 5"/></svg>',
  captions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.5 10.6a2.2 2.2 0 0 0-3.7 1.4 2.2 2.2 0 0 0 3.7 1.4M17 10.6a2.2 2.2 0 0 0-3.7 1.4 2.2 2.2 0 0 0 3.7 1.4"/></svg>',
  full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4H4v5m11-5h5v5M9 20H4v-5m11 5h5v-5"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5"/><path d="M4.5 19.5h15"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>',
  film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="M8 5v14M16 5v14M3.5 9.5H8m8 0h4.5M3.5 14.5H8m8 0h4.5"/></svg>',
};

const LOGO =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="#635bff" stroke-width="2.6"/><circle cx="12" cy="12" r="3.4" fill="#ff453a"/></svg>';

function shell(title: string, bodyHtml: string, opts: { embed?: boolean; script?: string } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body${opts.embed ? ' class="embed"' : ''}>
${bodyHtml}
${opts.script ? `<script>${opts.script}</script>` : ''}
</body>
</html>`;
}

function header(dateLabel: string): string {
  return `<header class="top">
  <span class="brand">${LOGO}<span>Open Loom</span></span>
  <span class="top-date">${escapeHtml(dateLabel)}</span>
</header>`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Client behaviour for the watch page. Written without template literals or
 * ${ sequences so it can live inside this module's template string safely.
 */
const WATCH_JS = String.raw`
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('ol-data').textContent);
  var video = document.getElementById('ol-video');
  var SPEEDS = [0.8, 1, 1.2, 1.5, 1.7, 2, 2.5];

  function $(id) { return document.getElementById(id); }
  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var s = Math.floor(sec % 60), m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600);
    var mm = (h && m < 10 ? '0' : '') + m, ss = (s < 10 ? '0' : '') + s;
    return (h ? h + ':' : '') + mm + ':' + ss;
  }
  function esc(el, text) { el.textContent = text; }
  function api(path, opts) {
    return fetch('/v/' + data.id + path, opts).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Request failed'); return j; });
    });
  }
  function rand(n) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-', out = '';
    var buf = new Uint8Array(n); crypto.getRandomValues(buf);
    for (var i = 0; i < n; i++) out += chars[buf[i] % 64];
    return out;
  }

  // ---- player ----
  var playBtn = $('ol-play'), bigPlay = $('ol-bigplay');
  var curEl = $('ol-cur'), durEl = $('ol-dur');
  var scrub = $('ol-scrub'), played = $('ol-played'), buffered = $('ol-buffered'), knob = $('ol-knob'), tip = $('ol-tip');
  var speedBtn = $('ol-speed'), speedMenu = $('ol-speedmenu');
  var volBtn = $('ol-volbtn'), volRange = $('ol-vol');
  var ccBtn = $('ol-cc'), fsBtn = $('ol-fs');
  var duration = data.durationSec || 0;

  function updatePlayIcon() {
    playBtn.innerHTML = video.paused ? window.OL_ICONS.play : window.OL_ICONS.pause;
    playBtn.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
    bigPlay.classList.toggle('hidden', !video.paused);
  }
  function togglePlay() { if (video.paused) { video.play(); } else { video.pause(); } }
  playBtn.addEventListener('click', togglePlay);
  bigPlay.addEventListener('click', togglePlay);
  video.addEventListener('click', togglePlay);
  video.addEventListener('play', updatePlayIcon);
  video.addEventListener('pause', updatePlayIcon);
  video.addEventListener('loadedmetadata', function () {
    if (isFinite(video.duration) && video.duration > 0) duration = video.duration;
    esc(durEl, fmt(duration));
  });
  esc(durEl, fmt(duration));

  function pctFromEvent(e) {
    var rect = scrub.getBoundingClientRect();
    var x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    return Math.min(1, Math.max(0, x / rect.width));
  }
  var dragging = false;
  scrub.addEventListener('pointerdown', function (e) {
    dragging = true; scrub.classList.add('dragging'); scrub.setPointerCapture(e.pointerId);
    video.currentTime = pctFromEvent(e) * duration;
  });
  scrub.addEventListener('pointermove', function (e) {
    var pct = pctFromEvent(e);
    tip.style.left = (pct * 100) + '%';
    esc(tip, fmt(pct * duration));
    if (dragging) video.currentTime = pct * duration;
  });
  scrub.addEventListener('pointerup', function () { dragging = false; scrub.classList.remove('dragging'); });
  video.addEventListener('timeupdate', function () {
    var pct = duration ? (video.currentTime / duration) * 100 : 0;
    played.style.width = pct + '%';
    knob.style.left = pct + '%';
    esc(curEl, fmt(video.currentTime));
    markCoverage(video.currentTime);
    highlightChapter(video.currentTime);
    highlightCue(video.currentTime);
  });
  video.addEventListener('progress', function () {
    try {
      if (video.buffered.length && duration) {
        buffered.style.width = ((video.buffered.end(video.buffered.length - 1) / duration) * 100) + '%';
      }
    } catch (err) { /* buffered ranges can be empty mid-seek */ }
  });

  // speed menu
  SPEEDS.forEach(function (s) {
    var b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = '<span>' + s + '×</span>' + (s === 1 ? '<span>default</span>' : '');
    if (s === 1) b.classList.add('sel');
    b.addEventListener('click', function () {
      video.playbackRate = s;
      esc(speedBtn, s + '×');
      speedMenu.querySelectorAll('button').forEach(function (x) { x.classList.remove('sel'); });
      b.classList.add('sel');
      speedMenu.classList.remove('open');
    });
    speedMenu.appendChild(b);
  });
  speedBtn.addEventListener('click', function (e) { e.stopPropagation(); speedMenu.classList.toggle('open'); });
  document.addEventListener('click', function () { speedMenu.classList.remove('open'); });

  // volume
  function updateVolIcon() { volBtn.innerHTML = (video.muted || video.volume === 0) ? window.OL_ICONS.muted : window.OL_ICONS.volume; }
  volBtn.addEventListener('click', function () { video.muted = !video.muted; updateVolIcon(); });
  volRange.addEventListener('input', function () { video.volume = Number(volRange.value); video.muted = false; updateVolIcon(); });
  video.addEventListener('volumechange', function () { volRange.value = String(video.muted ? 0 : video.volume); updateVolIcon(); });

  // captions
  var ccOn = false;
  function setCaptions(on) {
    var tracks = video.textTracks;
    if (!tracks.length) return;
    ccOn = on;
    for (var i = 0; i < tracks.length; i++) tracks[i].mode = on ? 'showing' : 'hidden';
    if (ccBtn) ccBtn.classList.toggle('active', on);
  }
  if (ccBtn) {
    setCaptions(false);
    ccBtn.addEventListener('click', function () { setCaptions(!ccOn); });
  }

  // fullscreen
  fsBtn.addEventListener('click', function () {
    var box = $('ol-videobox');
    if (document.fullscreenElement) { document.exitFullscreen(); } else { box.requestFullscreen(); }
  });

  // keyboard
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { video.currentTime = Math.max(0, video.currentTime - 5); }
    else if (e.key === 'ArrowRight') { video.currentTime = Math.min(duration, video.currentTime + 5); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); video.muted = false; }
    else if (e.key === 'ArrowDown') { e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); }
    else if (e.key === 'f' || e.key === 'F') { fsBtn.click(); }
    else if ((e.key === 'c' || e.key === 'C') && ccBtn) { setCaptions(!ccOn); }
  });

  // ---- chapters ----
  var chapterEls = [];
  function highlightChapter(t) {
    for (var i = 0; i < chapterEls.length; i++) {
      var isNow = t >= chapterEls[i].t && (i === chapterEls.length - 1 || t < chapterEls[i + 1].t);
      chapterEls[i].el.classList.toggle('now', isNow);
    }
  }
  var chapterList = $('ol-chapters');
  if (chapterList && data.chapters) {
    data.chapters.forEach(function (ch) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'chapter';
      var tEl = document.createElement('span'); tEl.className = 't'; esc(tEl, fmt(ch.t));
      var nEl = document.createElement('span'); esc(nEl, ch.title);
      b.appendChild(tEl); b.appendChild(nEl);
      b.addEventListener('click', function () { video.currentTime = ch.t; video.play(); });
      chapterList.appendChild(b);
      chapterEls.push({ t: ch.t, el: b });
    });
  }

  // ---- transcript ----
  var cueEls = [];
  function parseVtt(text) {
    var cues = [], lines = text.split(/\r?\n/), i = 0;
    function ts(v) {
      var m = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)/.exec(v);
      if (!m) return null;
      return (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]) + Number('0.' + m[4]);
    }
    while (i < lines.length) {
      var line = lines[i];
      if (line.indexOf('-->') !== -1) {
        var parts = line.split('-->');
        var start = ts(parts[0].trim()), end = ts(parts[1].trim().split(' ')[0]);
        var textLines = [];
        i++;
        while (i < lines.length && lines[i].trim() !== '') { textLines.push(lines[i]); i++; }
        if (start !== null && textLines.length) cues.push({ start: start, end: end === null ? start : end, text: textLines.join(' ') });
      }
      i++;
    }
    return cues;
  }
  function highlightCue(t) {
    for (var i = 0; i < cueEls.length; i++) {
      cueEls[i].el.classList.toggle('now', t >= cueEls[i].start && t <= cueEls[i].end);
    }
  }
  var cueList = $('ol-transcript');
  if (cueList && data.hasCaptions) {
    fetch('/v/' + data.id + '/captions.vtt').then(function (r) { return r.text(); }).then(function (text) {
      var cues = parseVtt(text);
      if (!cues.length) { cueList.innerHTML = '<div class="rail-empty">No transcript lines yet.</div>'; return; }
      cues.forEach(function (cue) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'cue';
        var tEl = document.createElement('span'); tEl.className = 't'; esc(tEl, fmt(cue.start));
        var xEl = document.createElement('span'); esc(xEl, cue.text);
        b.appendChild(tEl); b.appendChild(xEl);
        b.addEventListener('click', function () { video.currentTime = cue.start; video.play(); });
        cueList.appendChild(b);
        cueEls.push({ start: cue.start, end: cue.end, el: b });
      });
    }).catch(function () {
      cueList.innerHTML = '<div class="rail-empty">The transcript could not be loaded.</div>';
    });
  }

  // rail tabs
  document.querySelectorAll('.rail-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.rail-tab').forEach(function (x) { x.classList.remove('sel'); });
      tab.classList.add('sel');
      document.querySelectorAll('.rail-pane').forEach(function (pane) {
        pane.style.display = pane.id === tab.getAttribute('data-pane') ? '' : 'none';
      });
    });
  });

  // ---- session identity ----
  var sessionId;
  try {
    sessionId = localStorage.getItem('ol_session');
    if (!sessionId) { sessionId = rand(21); localStorage.setItem('ol_session', sessionId); }
  } catch (err) { sessionId = rand(21); }
  var viewId = rand(21);

  // ---- reactions ----
  var mine = [];
  function renderReactions(counts, mineList) {
    mine = mineList || mine;
    document.querySelectorAll('.react').forEach(function (btn) {
      var emoji = btn.getAttribute('data-emoji');
      var n = (counts && counts[emoji]) || 0;
      btn.querySelector('.n').textContent = String(n);
      btn.classList.toggle('mine', mine.indexOf(emoji) !== -1);
    });
  }
  if (data.allowReactions) {
    api('/reactions?sessionId=' + sessionId).then(function (j) { renderReactions(j.counts, j.mine); }).catch(function () {});
    document.querySelectorAll('.react').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var emoji = btn.getAttribute('data-emoji');
        var remove = mine.indexOf(emoji) !== -1;
        api('/reactions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ emoji: emoji, sessionId: sessionId, remove: remove }),
        }).then(function (j) { renderReactions(j.counts, j.mine); }).catch(function () {});
      });
    });
  }

  // ---- comments ----
  var replyTo = null;
  function commentNode(c, isReply) {
    var item = document.createElement('div');
    item.className = 'c-item';
    var head = document.createElement('div'); head.className = 'c-head';
    var av = document.createElement('span'); av.className = 'avatar'; esc(av, (c.author || 'A').slice(0, 1).toUpperCase());
    var who = document.createElement('span'); who.className = 'c-author'; esc(who, c.author);
    head.appendChild(av); head.appendChild(who);
    if (typeof c.atSec === 'number') {
      var chipBtn = document.createElement('button');
      chipBtn.type = 'button'; chipBtn.className = 't-chip'; esc(chipBtn, fmt(c.atSec));
      chipBtn.title = 'Jump to ' + fmt(c.atSec);
      chipBtn.addEventListener('click', function () { video.currentTime = c.atSec; video.play(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
      head.appendChild(chipBtn);
    }
    var when = document.createElement('span'); when.className = 'c-when';
    esc(when, new Date(c.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));
    head.appendChild(when);
    item.appendChild(head);
    var text = document.createElement('div'); text.className = 'c-text'; esc(text, c.text);
    item.appendChild(text);
    if (!isReply) {
      var actions = document.createElement('div'); actions.className = 'c-actions';
      var reply = document.createElement('button');
      reply.type = 'button'; reply.className = 'c-reply-btn'; esc(reply, 'Reply');
      reply.addEventListener('click', function () {
        replyTo = c;
        var label = $('ol-replying');
        esc(label, 'Replying to ' + c.author);
        label.style.display = '';
        $('ol-ctext').focus();
      });
      actions.appendChild(reply);
      item.appendChild(actions);
    }
    return item;
  }
  function renderComments(list) {
    var wrap = $('ol-clist');
    wrap.innerHTML = '';
    var tops = list.filter(function (c) { return !c.parentId; });
    $('ol-ccount').textContent = '(' + list.length + ')';
    if (!tops.length) {
      var empty = document.createElement('div'); empty.className = 'c-empty';
      esc(empty, 'No comments yet. Be the first to leave one.');
      wrap.appendChild(empty);
      return;
    }
    tops.forEach(function (c) {
      var node = commentNode(c, false);
      var replies = list.filter(function (r) { return r.parentId === c.id; });
      if (replies.length) {
        var sub = document.createElement('div'); sub.className = 'c-replies';
        replies.forEach(function (r) { sub.appendChild(commentNode(r, true)); });
        node.appendChild(sub);
      }
      wrap.appendChild(node);
    });
  }
  function loadComments() {
    api('/comments').then(function (j) { renderComments(j.comments); }).catch(function () {});
  }
  if (data.allowComments) {
    loadComments();
    var nameInput = $('ol-cname'), textInput = $('ol-ctext'), atChip = $('ol-atchip'), postBtn = $('ol-cpost');
    try { nameInput.value = localStorage.getItem('ol_name') || ''; } catch (err) {}
    var atOn = true, atTime = 0;
    function refreshChip() {
      atChip.classList.toggle('on', atOn);
      atChip.textContent = (atOn ? '✓ ' : '') + 'at ' + fmt(atTime);
    }
    textInput.addEventListener('focus', function () { if (!textInput.value) { atTime = video.currentTime; refreshChip(); } });
    atChip.addEventListener('click', function () { atOn = !atOn; if (atOn) atTime = video.currentTime; refreshChip(); });
    refreshChip();
    postBtn.addEventListener('click', function () {
      var text = textInput.value.trim();
      if (!text) { textInput.focus(); return; }
      var author = nameInput.value.trim();
      try { if (author) localStorage.setItem('ol_name', author); } catch (err) {}
      postBtn.disabled = true;
      api('/comments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          author: author || 'Anonymous',
          text: text,
          atSec: atOn && !replyTo ? atTime : null,
          parentId: replyTo ? replyTo.id : null,
        }),
      }).then(function () {
        textInput.value = '';
        replyTo = null;
        $('ol-replying').style.display = 'none';
        loadComments();
      }).catch(function (err) {
        alert(err.message);
      }).finally(function () { postBtn.disabled = false; });
    });
    $('ol-replycancel').addEventListener('click', function () {
      replyTo = null; $('ol-replying').style.display = 'none';
    });
  }

  // ---- beacons + coverage ----
  var BUCKETS = 100;
  var pending = [];
  var seen = {};
  function markCoverage(t) {
    if (!duration) return;
    var b = Math.min(BUCKETS - 1, Math.floor((t / duration) * BUCKETS));
    if (!seen[b]) { seen[b] = true; pending.push(b); }
  }
  function beaconBody() {
    var name = '';
    try { name = localStorage.getItem('ol_name') || ''; } catch (err) {}
    var body = { viewId: viewId, sessionId: sessionId, positionSec: video.currentTime || 0, coverage: pending.splice(0, pending.length) };
    if (name) body.name = name;
    return body;
  }
  function sendBeacon() {
    fetch('/v/' + data.id + '/beacon', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(beaconBody()),
      keepalive: true,
    }).catch(function () {});
  }
  sendBeacon(); // register the view on load
  setInterval(function () { if (!video.paused) sendBeacon(); }, 5000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      try {
        navigator.sendBeacon('/v/' + data.id + '/beacon', new Blob([JSON.stringify(beaconBody())], { type: 'application/json' }));
      } catch (err) { /* beacon is best-effort */ }
    }
  });

  updatePlayIcon();
  updateVolIcon();
})();
`;

export function renderWatchPage(data: WatchPageData): string {
  const hasRail = data.chapters.length > 0 || data.hasCaptions;
  const dateLabel = formatDate(data.createdAt);
  const dataJson = JSON.stringify({
    id: data.id,
    durationSec: data.durationSec,
    chapters: data.embed ? [] : data.chapters,
    hasCaptions: data.hasCaptions,
    // The embed variant is chromeless: no comment form or reaction bar exists.
    allowComments: data.allowComments && !data.embed,
    allowReactions: data.allowReactions && !data.embed,
  }).replace(/</g, '\\u003c');

  const reactionsHtml = data.allowReactions
    ? `<div class="reactions" aria-label="Reactions">${['\u{1F44D}', '❤️', '\u{1F602}', '\u{1F389}', '\u{1F440}']
        .map(
          (emoji) =>
            `<button type="button" class="react" data-emoji="${emoji}" aria-label="React with ${emoji}"><span>${emoji}</span><span class="n">${data.reactions[emoji] ?? 0}</span></button>`
        )
        .join('')}</div>`
    : '';

  const ctaHtml = data.cta
    ? `<a class="btn btn-accent" href="${escapeHtml(data.cta.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(data.cta.label)}</a>`
    : '';

  const downloadHtml = data.allowDownload
    ? `<a class="btn" href="/v/${data.id}/download">${ICONS.download}<span>Download</span></a>`
    : '';

  const railHtml = hasRail
    ? `<aside class="rail">
  <div class="rail-card">
    <div class="rail-tabs" role="tablist">
      ${data.chapters.length ? `<button type="button" class="rail-tab sel" data-pane="ol-chapters" role="tab">Chapters</button>` : ''}
      ${data.hasCaptions ? `<button type="button" class="rail-tab${data.chapters.length ? '' : ' sel'}" data-pane="ol-transcript" role="tab">Transcript</button>` : ''}
    </div>
    ${data.chapters.length ? `<div class="rail-body rail-pane" id="ol-chapters"></div>` : ''}
    ${data.hasCaptions ? `<div class="rail-body rail-pane" id="ol-transcript"${data.chapters.length ? ' style="display:none"' : ''}></div>` : ''}
  </div>
</aside>`
    : '';

  const commentsHtml = data.allowComments
    ? `<section class="comments">
  <h2>Comments <span class="n" id="ol-ccount"></span></h2>
  <div class="c-form">
    <div class="row">
      <input id="ol-cname" type="text" placeholder="Your name" maxlength="80" aria-label="Your name">
      <span class="c-when" id="ol-replying" style="display:none"></span>
      <button type="button" class="c-reply-btn" id="ol-replycancel">Cancel reply</button>
    </div>
    <textarea id="ol-ctext" placeholder="Leave a comment" maxlength="5000" aria-label="Comment text"></textarea>
    <div class="row">
      <button type="button" class="chip on" id="ol-atchip" title="Attach the current video time"></button>
      <button type="button" class="post-btn" id="ol-cpost">Post comment</button>
    </div>
  </div>
  <div class="c-list" id="ol-clist"></div>
</section>`
    : '';

  const playerHtml = `<div class="player-card">
  <div class="video-box" id="ol-videobox">
    <video id="ol-video" src="/v/${data.id}/stream" preload="metadata"${data.hasThumb ? ` poster="/v/${data.id}/thumb.jpg"` : ''} playsinline>
      ${data.hasCaptions ? `<track kind="subtitles" label="Captions" srclang="en" src="/v/${data.id}/captions.vtt">` : ''}
    </video>
    <button type="button" class="big-play" id="ol-bigplay" aria-label="Play"><span class="disc">${ICONS.play}</span></button>
    ${data.embed ? `<span class="embed-title">${escapeHtml(data.title)}</span>` : ''}
  </div>
  <div class="controls">
    <button type="button" class="ctrl" id="ol-play" aria-label="Play">${ICONS.play}</button>
    <span class="time"><span id="ol-cur">0:00</span> / <span id="ol-dur">0:00</span></span>
    <div class="scrub" id="ol-scrub" role="slider" aria-label="Seek" tabindex="0">
      <div class="track">
        <div class="buffered" id="ol-buffered"></div>
        <div class="played" id="ol-played"></div>
        <div class="knob" id="ol-knob"></div>
      </div>
      <div class="tip" id="ol-tip">0:00</div>
    </div>
    <button type="button" class="ctrl speed-label" id="ol-speed" aria-label="Playback speed">1×</button>
    <div class="speed-menu" id="ol-speedmenu"></div>
    <span class="vol">
      <button type="button" class="ctrl" id="ol-volbtn" aria-label="Mute"></button>
      <input id="ol-vol" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">
    </span>
    ${data.hasCaptions ? `<button type="button" class="ctrl" id="ol-cc" aria-label="Captions">${ICONS.captions}</button>` : ''}
    <button type="button" class="ctrl" id="ol-fs" aria-label="Fullscreen">${ICONS.full}</button>
  </div>
</div>`;

  if (data.embed) {
    return shell(data.title, playerHtml, {
      embed: true,
      script: `window.OL_ICONS=${JSON.stringify({ play: ICONS.play, pause: ICONS.pause, volume: ICONS.volume, muted: ICONS.muted })};`,
    })
      .replace('</body>', `<script id="ol-data" type="application/json">${dataJson}</script><script>${WATCH_JS}</script></body>`);
  }

  const body = `${header(dateLabel)}
<div class="layout${hasRail ? ' has-rail' : ''}">
  <main>
    ${playerHtml}
    <div class="headline">
      <h1>${escapeHtml(data.title)}</h1>
      <div class="byline">
        ${data.creator ? `<span>${escapeHtml(data.creator)}</span><span class="dot"></span>` : ''}
        <span>${escapeHtml(dateLabel)}</span>
      </div>
    </div>
    <div class="action-row">
      ${reactionsHtml}
      <span class="spacer"></span>
      ${downloadHtml}
      ${ctaHtml}
    </div>
    ${commentsHtml}
  </main>
  ${railHtml}
</div>
<footer class="foot">Recorded with Open Loom, the open-source screen recorder you host yourself.</footer>
<script id="ol-data" type="application/json">${dataJson}</script>
<script>window.OL_ICONS=${JSON.stringify({ play: ICONS.play, pause: ICONS.pause, volume: ICONS.volume, muted: ICONS.muted })};</script>
<script>${WATCH_JS}</script>`;

  return shell(data.title, body);
}

export function renderProcessingPage(title: string, videoId: string, embed: boolean): string {
  const body = `${embed ? '' : header('')}
<div class="center-wrap">
  <div class="center-card">
    <div class="spin" role="status" aria-label="Processing"></div>
    <h1>${escapeHtml(title)}</h1>
    <p>This video is still uploading. The page refreshes itself the moment it is ready.</p>
  </div>
</div>`;
  const script = `
(function () {
  function poll() {
    fetch('/v/${videoId}/status').then(function (r) { return r.json(); }).then(function (j) {
      if (j.status === 'ready') { location.reload(); } else { setTimeout(poll, 2000); }
    }).catch(function () { setTimeout(poll, 5000); });
  }
  setTimeout(poll, 2000);
})();`;
  return shell(`${title} - processing`, body, { embed, script });
}

export function renderPasswordPage(videoId: string, embed: boolean): string {
  const body = `${embed ? '' : header('')}
<div class="center-wrap">
  <div class="center-card">
    <span class="glyph">${ICONS.lock}</span>
    <h1>This video is password protected</h1>
    <p>Enter the password the creator shared with you.</p>
    <form id="ol-unlock-form">
      <input type="password" id="ol-pw" placeholder="Password" autocomplete="current-password" autofocus aria-label="Password">
      <span class="form-error" id="ol-pw-error"></span>
      <button type="submit" class="unlock">Unlock video</button>
    </form>
  </div>
</div>`;
  const script = `
(function () {
  var form = document.getElementById('ol-unlock-form');
  var input = document.getElementById('ol-pw');
  var errorEl = document.getElementById('ol-pw-error');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorEl.textContent = '';
    fetch('/v/${videoId}/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: input.value }),
    }).then(function (r) {
      if (r.ok) { location.reload(); return null; }
      return r.json();
    }).then(function (j) {
      if (j) { errorEl.textContent = j.error || 'That password is not right.'; input.select(); }
    }).catch(function () {
      errorEl.textContent = 'Could not reach the server. Try again.';
    });
  });
})();`;
  return shell('Password protected video', body, { embed, script });
}

export function renderNotFoundPage(): string {
  const body = `${header('')}
<div class="center-wrap">
  <div class="center-card">
    <span class="glyph">${ICONS.film}</span>
    <h1>This video does not exist</h1>
    <p>The link may be wrong, or the creator removed the video from this server.</p>
  </div>
</div>`;
  return shell('Video not found', body);
}
