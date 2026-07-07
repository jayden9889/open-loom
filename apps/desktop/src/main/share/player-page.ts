/**
 * Self-contained static player page uploaded next to the video by the S3
 * provider (SPEC S3). Same design language as the app and the server watch
 * page (D1/D4): inline CSS + vanilla JS, zero external requests. Assets are
 * referenced relatively (video.mp4, thumb.jpg, captions.vtt) so the page
 * works from any public bucket or custom domain.
 */

export interface PlayerPageOptions {
  title: string;
  creator?: string | null;
  createdAt: string;
  durationSec: number;
  chapters: { t: number; title: string }[];
  hasCaptions: boolean;
  hasThumb: boolean;
  allowDownload: boolean;
  cta?: { label: string; url: string } | null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `
:root {
  --ol-font: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --ol-accent: #635bff; --ol-accent-hover: #574edb; --ol-accent-soft: rgba(99, 91, 255, 0.12);
  --ol-radius-card: 12px; --ol-radius-control: 8px;
  --ol-bg: #f5f5f7; --ol-surface: #ffffff; --ol-text: #1d1d1f; --ol-text-secondary: #6e6e73;
  --ol-text-tertiary: #aeaeb2; --ol-border: rgba(0,0,0,0.1); --ol-border-strong: rgba(0,0,0,0.18);
  --ol-hover: rgba(0,0,0,0.045); --ol-elev-card: 0 1px 3px rgba(0,0,0,0.08); --ol-on-accent: #fff;
}
@media (prefers-color-scheme: dark) {
  :root { --ol-bg: #1d1d1f; --ol-surface: #2c2c2e; --ol-text: #f5f5f7; --ol-text-secondary: #98989d;
    --ol-text-tertiary: #636366; --ol-border: rgba(255,255,255,0.12); --ol-border-strong: rgba(255,255,255,0.22);
    --ol-hover: rgba(255,255,255,0.06); --ol-elev-card: 0 1px 3px rgba(0,0,0,0.3); --ol-accent-soft: rgba(99,91,255,0.22); }
}
:root[data-theme='light'] { --ol-bg: #f5f5f7; --ol-surface: #fff; --ol-text: #1d1d1f; --ol-text-secondary: #6e6e73;
  --ol-text-tertiary: #aeaeb2; --ol-border: rgba(0,0,0,0.1); --ol-border-strong: rgba(0,0,0,0.18);
  --ol-hover: rgba(0,0,0,0.045); --ol-elev-card: 0 1px 3px rgba(0,0,0,0.08); --ol-accent-soft: rgba(99,91,255,0.12); }
:root[data-theme='dark'] { --ol-bg: #1d1d1f; --ol-surface: #2c2c2e; --ol-text: #f5f5f7; --ol-text-secondary: #98989d;
  --ol-text-tertiary: #636366; --ol-border: rgba(255,255,255,0.12); --ol-border-strong: rgba(255,255,255,0.22);
  --ol-hover: rgba(255,255,255,0.06); --ol-elev-card: 0 1px 3px rgba(0,0,0,0.3); --ol-accent-soft: rgba(99,91,255,0.22); }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--ol-font); background: var(--ol-bg); color: var(--ol-text); font-size: 14px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
button:focus-visible, a:focus-visible { outline: 2px solid var(--ol-accent); outline-offset: 2px; border-radius: 4px; }
a { color: var(--ol-accent); text-decoration: none; }
.top { display: flex; align-items: center; justify-content: space-between; padding: 12px 24px; max-width: 1100px; margin: 0 auto; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 15px; }
.top-date { color: var(--ol-text-secondary); font-size: 12px; }
.layout { max-width: 1100px; margin: 0 auto; padding: 0 24px 48px; display: grid; gap: 24px; grid-template-columns: 1fr; }
.layout.has-rail { grid-template-columns: minmax(0,1fr) 300px; }
@media (max-width: 900px) { .layout.has-rail { grid-template-columns: 1fr; } }
.card { background: var(--ol-surface); border: 1px solid var(--ol-border); border-radius: var(--ol-radius-card); box-shadow: var(--ol-elev-card); overflow: hidden; }
.video-box { position: relative; background: #000; }
video { display: block; width: 100%; max-height: 72vh; background: #000; }
.big { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #fff; transition: opacity 180ms; }
.big .disc { width: 72px; height: 72px; border-radius: 999px; background: var(--ol-accent); display: flex; align-items: center; justify-content: center; }
.big.hidden { opacity: 0; pointer-events: none; }
.controls { display: flex; align-items: center; gap: 4px; padding: 8px 12px; border-top: 1px solid var(--ol-border); position: relative; }
.ctrl { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: var(--ol-radius-control); color: var(--ol-text-secondary); }
.ctrl:hover { background: var(--ol-hover); color: var(--ol-text); }
.ctrl.active { color: var(--ol-accent); background: var(--ol-accent-soft); }
.ctrl svg { width: 18px; height: 18px; }
.time { font-variant-numeric: tabular-nums; font-size: 12px; color: var(--ol-text-secondary); padding: 0 6px; white-space: nowrap; }
.scrub { flex: 1; height: 24px; display: flex; align-items: center; cursor: pointer; position: relative; touch-action: none; }
.scrub .track { position: relative; width: 100%; height: 4px; border-radius: 999px; background: var(--ol-border-strong); }
.scrub .played { position: absolute; inset: 0 auto 0 0; border-radius: 999px; background: var(--ol-accent); width: 0; }
.speed { font-size: 12px; font-weight: 600; width: auto; padding: 0 8px; }
.menu { position: absolute; bottom: 44px; right: 12px; background: var(--ol-surface); border: 1px solid var(--ol-border); border-radius: var(--ol-radius-control); box-shadow: var(--ol-elev-card); padding: 4px; display: none; min-width: 80px; z-index: 5; }
.menu.open { display: block; }
.menu button { display: block; width: 100%; text-align: left; padding: 6px 10px; border-radius: 6px; font-size: 13px; }
.menu button:hover { background: var(--ol-hover); }
.menu button.sel { color: var(--ol-accent); font-weight: 600; }
h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; margin-top: 20px; }
.byline { margin-top: 4px; color: var(--ol-text-secondary); font-size: 13px; }
.actions { display: flex; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
.btn { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: var(--ol-radius-control); font-weight: 600; font-size: 13px; border: 1px solid var(--ol-border); background: var(--ol-surface); color: var(--ol-text); }
.btn:hover { background: var(--ol-hover); }
.btn-accent { background: var(--ol-accent); border-color: var(--ol-accent); color: var(--ol-on-accent); }
.btn-accent:hover { background: var(--ol-accent-hover); }
.rail-card { background: var(--ol-surface); border: 1px solid var(--ol-border); border-radius: var(--ol-radius-card); box-shadow: var(--ol-elev-card); }
.rail-title { font-size: 13px; font-weight: 700; padding: 12px 14px 4px; }
.rail-body { max-height: 60vh; overflow-y: auto; padding: 8px; }
.row-btn { display: flex; gap: 10px; width: 100%; text-align: left; padding: 7px 10px; border-radius: var(--ol-radius-control); align-items: baseline; font-size: 13px; }
.row-btn:hover { background: var(--ol-hover); }
.row-btn.now { background: var(--ol-accent-soft); }
.row-btn .t { font-variant-numeric: tabular-nums; color: var(--ol-accent); font-size: 11px; min-width: 40px; font-weight: 600; }
.foot { max-width: 1100px; margin: 0 auto; padding: 0 24px 32px; color: var(--ol-text-tertiary); font-size: 12px; }
`;

const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a.8.8 0 0 0 1.22.68l10.3-6.5a.8.8 0 0 0 0-1.36L9.22 4.82A.8.8 0 0 0 8 5.5Z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2"/></svg>';
const FULL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4H4v5m11-5h5v5M9 20H4v-5m11 5h5v-5"/></svg>';
const CC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.5 10.6a2.2 2.2 0 0 0-3.7 1.4 2.2 2.2 0 0 0 3.7 1.4M17 10.6a2.2 2.2 0 0 0-3.7 1.4 2.2 2.2 0 0 0 3.7 1.4"/></svg>';
const DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5"/><path d="M4.5 19.5h15"/></svg>';
const LOGO =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="#635bff" stroke-width="2.6"/><circle cx="12" cy="12" r="3.4" fill="#ff453a"/></svg>';

/** Vanilla client JS; written without backticks or ${ so it nests safely. */
const JS = String.raw`
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('ol-data').textContent);
  var video = document.getElementById('ol-video');
  var SPEEDS = [0.8, 1, 1.2, 1.5, 1.7, 2, 2.5];
  function $(id) { return document.getElementById(id); }
  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var s = Math.floor(sec % 60), m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600);
    return (h ? h + ':' : '') + (h && m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  var duration = data.durationSec || 0;
  var playBtn = $('ol-play'), big = $('ol-big'), cur = $('ol-cur'), dur = $('ol-dur');
  var scrub = $('ol-scrub'), played = $('ol-played');
  var speedBtn = $('ol-speed'), menu = $('ol-menu'), ccBtn = $('ol-cc'), fsBtn = $('ol-fs');
  function icons() {
    playBtn.innerHTML = video.paused ? window.OL_I.play : window.OL_I.pause;
    big.classList.toggle('hidden', !video.paused);
  }
  function toggle() { if (video.paused) { video.play(); } else { video.pause(); } }
  playBtn.addEventListener('click', toggle);
  big.addEventListener('click', toggle);
  video.addEventListener('click', toggle);
  video.addEventListener('play', icons);
  video.addEventListener('pause', icons);
  video.addEventListener('loadedmetadata', function () {
    if (isFinite(video.duration) && video.duration > 0) duration = video.duration;
    dur.textContent = fmt(duration);
  });
  dur.textContent = fmt(duration);
  scrub.addEventListener('pointerdown', function (e) {
    var rect = scrub.getBoundingClientRect();
    video.currentTime = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * duration;
  });
  video.addEventListener('timeupdate', function () {
    played.style.width = (duration ? (video.currentTime / duration) * 100 : 0) + '%';
    cur.textContent = fmt(video.currentTime);
    var rows = document.querySelectorAll('.row-btn');
    for (var i = 0; i < rows.length; i++) {
      var start = Number(rows[i].getAttribute('data-t'));
      var next = i + 1 < rows.length ? Number(rows[i + 1].getAttribute('data-t')) : Infinity;
      var sameList = i + 1 < rows.length && rows[i + 1].parentElement === rows[i].parentElement;
      rows[i].classList.toggle('now', video.currentTime >= start && (sameList ? video.currentTime < next : true));
    }
  });
  SPEEDS.forEach(function (s) {
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = s + '×';
    if (s === 1) b.classList.add('sel');
    b.addEventListener('click', function () {
      video.playbackRate = s;
      speedBtn.textContent = s + '×';
      menu.querySelectorAll('button').forEach(function (x) { x.classList.remove('sel'); });
      b.classList.add('sel');
      menu.classList.remove('open');
    });
    menu.appendChild(b);
  });
  speedBtn.addEventListener('click', function (e) { e.stopPropagation(); menu.classList.toggle('open'); });
  document.addEventListener('click', function () { menu.classList.remove('open'); });
  var ccOn = false;
  function setCC(on) {
    var tracks = video.textTracks;
    if (!tracks.length) return;
    ccOn = on;
    for (var i = 0; i < tracks.length; i++) tracks[i].mode = on ? 'showing' : 'hidden';
    if (ccBtn) ccBtn.classList.toggle('active', on);
  }
  if (ccBtn) { setCC(false); ccBtn.addEventListener('click', function () { setCC(!ccOn); }); }
  fsBtn.addEventListener('click', function () {
    if (document.fullscreenElement) { document.exitFullscreen(); } else { $('ol-box').requestFullscreen(); }
  });
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (e.key === ' ') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowLeft') { video.currentTime = Math.max(0, video.currentTime - 5); }
    else if (e.key === 'ArrowRight') { video.currentTime = Math.min(duration, video.currentTime + 5); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); }
    else if (e.key === 'f' || e.key === 'F') { fsBtn.click(); }
    else if ((e.key === 'c' || e.key === 'C') && ccBtn) { setCC(!ccOn); }
  });
  document.querySelectorAll('.row-btn').forEach(function (b) {
    b.addEventListener('click', function () { video.currentTime = Number(b.getAttribute('data-t')); video.play(); });
  });
  icons();
})();
`;

export function buildPlayerPage(opts: PlayerPageOptions): string {
  const dateLabel = new Date(opts.createdAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const hasRail = opts.chapters.length > 0;
  const dataJson = JSON.stringify({ durationSec: opts.durationSec }).replace(/</g, '\\u003c');

  const chaptersHtml = hasRail
    ? `<aside>
  <div class="rail-card">
    <div class="rail-title">Chapters</div>
    <div class="rail-body">
      ${opts.chapters
        .map(
          (ch) =>
            `<button type="button" class="row-btn" data-t="${ch.t}"><span class="t">${formatClock(ch.t)}</span><span>${escapeHtml(ch.title)}</span></button>`
        )
        .join('\n      ')}
    </div>
  </div>
</aside>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(opts.title)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <span class="brand">${LOGO}<span>Open Loom</span></span>
  <span class="top-date">${escapeHtml(dateLabel)}</span>
</header>
<div class="layout${hasRail ? ' has-rail' : ''}">
  <main>
    <div class="card">
      <div class="video-box" id="ol-box">
        <video id="ol-video" src="video.mp4" preload="metadata"${opts.hasThumb ? ' poster="thumb.jpg"' : ''} playsinline>
          ${opts.hasCaptions ? '<track kind="subtitles" label="Captions" srclang="en" src="captions.vtt">' : ''}
        </video>
        <button type="button" class="big" id="ol-big" aria-label="Play"><span class="disc">${PLAY}</span></button>
      </div>
      <div class="controls">
        <button type="button" class="ctrl" id="ol-play" aria-label="Play">${PLAY}</button>
        <span class="time"><span id="ol-cur">0:00</span> / <span id="ol-dur">0:00</span></span>
        <div class="scrub" id="ol-scrub" role="slider" aria-label="Seek" tabindex="0"><div class="track"><div class="played" id="ol-played"></div></div></div>
        <button type="button" class="ctrl speed" id="ol-speed" aria-label="Playback speed">1×</button>
        <div class="menu" id="ol-menu"></div>
        ${opts.hasCaptions ? `<button type="button" class="ctrl" id="ol-cc" aria-label="Captions">${CC}</button>` : ''}
        <button type="button" class="ctrl" id="ol-fs" aria-label="Fullscreen">${FULL}</button>
      </div>
    </div>
    <h1>${escapeHtml(opts.title)}</h1>
    <div class="byline">${opts.creator ? `${escapeHtml(opts.creator)} · ` : ''}${escapeHtml(dateLabel)}</div>
    <div class="actions">
      ${opts.allowDownload ? `<a class="btn" href="video.mp4" download>${DOWNLOAD}<span>Download</span></a>` : ''}
      ${opts.cta ? `<a class="btn btn-accent" href="${escapeHtml(opts.cta.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(opts.cta.label)}</a>` : ''}
    </div>
  </main>
  ${chaptersHtml}
</div>
<footer class="foot">Recorded with Open Loom, the open-source screen recorder you host yourself.</footer>
<script id="ol-data" type="application/json">${dataJson}</script>
<script>window.OL_I=${JSON.stringify({ play: PLAY, pause: PAUSE })};</script>
<script>${JS}</script>
</body>
</html>`;
}

function formatClock(sec: number): string {
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const mm = h && m < 10 ? `0${m}` : String(m);
  const ss = s < 10 ? `0${s}` : String(s);
  return `${h ? `${h}:` : ''}${mm}:${ss}`;
}
