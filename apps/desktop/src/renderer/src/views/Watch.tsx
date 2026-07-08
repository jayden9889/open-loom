/**
 * Watch view (SPEC L4-L7): custom player (click-to-pause, hover-timestamp
 * scrubber with buffered ranges, speed menu, volume, captions, fullscreen,
 * keyboard shortcuts) plus Details / Transcript / Chapters / Activity tabs
 * rendering real data when present and designed empty states when absent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Folder, Settings, VideoMeta } from '@shared/types';
import { Icon } from '../components/icons';
import { cleanIpcError, formatBytes, formatDate, formatDuration, useToasts } from '../components/ui';
import { ShareDialog } from '../components/share/ShareDialog';
import { ActivityPanel } from '../components/share/ActivityPanel';

/** Render transcript text with the search query highlighted. */
function HighlightedText({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let pos = 0;
  let idx: number;
  while ((idx = lower.indexOf(needle, pos)) >= 0) {
    if (idx > pos) parts.push(text.slice(pos, idx));
    parts.push(<mark key={idx}>{text.slice(idx, idx + q.length)}</mark>);
    pos = idx + q.length;
  }
  if (pos < text.length) parts.push(text.slice(pos));
  return <>{parts}</>;
}

const SPEEDS = [0.8, 1, 1.2, 1.5, 1.7, 2, 2.5];

interface VttCue {
  start: number;
  end: number;
  text: string;
}

function parseVttTime(t: string): number {
  const parts = t.trim().split(':');
  let sec = 0;
  for (const p of parts) sec = sec * 60 + parseFloat(p.replace(',', '.'));
  return sec;
}

function parseVtt(raw: string): VttCue[] {
  const cues: VttCue[] = [];
  const blocks = raw.replace(/\r/g, '').split('\n\n');
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    const timeLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIdx < 0) continue;
    const [startRaw, endRaw] = lines[timeLineIdx]!.split('-->');
    if (!startRaw || !endRaw) continue;
    const text = lines
      .slice(timeLineIdx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!text) continue;
    cues.push({ start: parseVttTime(startRaw), end: parseVttTime(endRaw.split(' ')[0] ?? endRaw), text });
  }
  return cues;
}

type Tab = 'details' | 'transcript' | 'chapters' | 'activity';

export function WatchView({
  id,
  folders,
  settings,
  onBack,
  onEdit,
  onChanged,
  onDeleted,
  onOpenSharingSettings,
}: {
  id: string;
  folders: Folder[];
  settings: Settings;
  onBack: () => void;
  onEdit: () => void;
  onChanged: () => Promise<void>;
  onDeleted: () => void;
  onOpenSharingSettings: () => void;
}) {
  const { push } = useToasts();
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [tab, setTab] = useState<Tab>('details');
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState<{ start: number; end: number }[]>([]);
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [cues, setCues] = useState<VttCue[] | null>(null);
  const [hoverT, setHoverT] = useState<{ x: number; t: number } | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [descDraft, setDescDraft] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [transcriptQuery, setTranscriptQuery] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [runningJob, setRunningJob] = useState<{ kind: string; pct: number; note?: string } | null>(null);
  const [chapterDraft, setChapterDraft] = useState<{ index: number; title: string } | null>(null);
  const [taskDraft, setTaskDraft] = useState<{ index: number; text: string } | null>(null);
  const [summaryDraft, setSummaryDraft] = useState<string | null>(null);
  const [youtubeOpen, setYoutubeOpen] = useState(false);
  const [youtubeDraft, setYoutubeDraft] = useState('');
  const [youtubeError, setYoutubeError] = useState<string | null>(null);

  const videoUrl = `${window.openloom.fileUrl(id, 'video.mp4')}?v=${refresh}`;
  const vttUrl = `${window.openloom.fileUrl(id, 'transcript.vtt')}?v=${refresh}`;

  const transcriptionConfigured = settings.transcription.engine !== 'off';
  const aiConfigured = settings.ai.provider !== 'off';

  useEffect(() => {
    void window.openloom
      .getVideo(id)
      .then(setMeta)
      .catch((err) => push('error', cleanIpcError(err)));
  }, [id, push, refresh]);

  // Live progress for transcription / AI / edit jobs on this video; reload
  // meta + captions when one lands.
  useEffect(() => {
    return window.openloom.onJobProgress((j) => {
      if (j.videoId !== id) return;
      // Share uploads surface here too (this is where the user lands after
      // stop + auto-share), so a failed background upload is visible rather than
      // leaving a confidently-copied link that 404s. The failure toast fires
      // globally; here we reload meta so the persistent "not live" state below
      // reflects whether uploadedAt was written.
      if (j.kind === 'upload') {
        if (j.pct >= 100) {
          setRefresh((r) => r + 1);
          void onChanged();
        }
        return;
      }
      if (!['transcribe', 'ai', 'trim', 'stitch', 'revert'].includes(j.kind)) return;
      if (j.pct >= 100) {
        setRunningJob(null);
        setRefresh((r) => r + 1);
        void onChanged();
      } else {
        setRunningJob({ kind: j.kind, pct: j.pct, note: j.note });
      }
    });
  }, [id, onChanged]);

  /** Merge a patch into meta.ai and persist. */
  const saveAi = useCallback(
    async (patch: Partial<NonNullable<VideoMeta['ai']>>) => {
      if (!meta) return;
      try {
        setMeta(await window.openloom.updateVideo(id, { ai: { ...meta.ai, ...patch } }));
      } catch (err) {
        push('error', cleanIpcError(err));
      }
    },
    [id, meta, push]
  );

  const transcribeNow = () => {
    push('info', 'Transcribing in the background. The transcript appears here when it is ready.');
    void window.openloom.transcribeVideo(id).catch((err) => push('error', cleanIpcError(err)));
  };

  const generateNow = (kinds: string[]) => {
    push('info', 'Generating with AI.');
    void window.openloom.generateAI(id, kinds).then(
      () => setRefresh((r) => r + 1),
      (err) => push('error', cleanIpcError(err))
    );
  };

  // Guided "Publish to YouTube (unlisted)": main reveals the MP4 in Finder and
  // opens youtube.com/upload; the AI title (if any) is copied for pasting.
  const startYouTubePublish = () => {
    setTab('details');
    setYoutubeOpen(true);
    setYoutubeError(null);
    void window.openloom.youtubePublishStart(id).then(
      (res) => {
        if (res.titleCopied) {
          push('info', 'Your AI title is on the clipboard, ready to paste into the YouTube title field.');
        }
      },
      (err) => push('error', cleanIpcError(err))
    );
  };

  const saveYouTubeLink = () => {
    setYoutubeError(null);
    void window.openloom.youtubeSaveLink(id, youtubeDraft).then(
      (m) => {
        setMeta(m);
        setYoutubeDraft('');
        if (m.youtubeUrl) {
          window.openloom.copyToClipboard(m.youtubeUrl);
          push('success', 'YouTube link saved and copied.');
        }
        void onChanged();
      },
      (err) => setYoutubeError(cleanIpcError(err))
    );
  };

  // Load captions when present (transcription module writes transcript.vtt).
  useEffect(() => {
    let cancelled = false;
    void fetch(vttUrl)
      .then(async (res) => {
        if (!res.ok) throw new Error('no captions');
        const text = await res.text();
        if (!cancelled) setCues(parseVtt(text));
      })
      .catch(() => {
        if (!cancelled) setCues(null);
      });
    return () => {
      cancelled = true;
    };
  }, [vttUrl]);

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(t)) return;
    v.currentTime = Math.max(0, Math.min(t, v.duration || t));
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  }, []);

  // Keyboard shortcuts (SPEC L4).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      const v = videoRef.current;
      if (!v) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          seek(v.currentTime - 5);
          break;
        case 'ArrowRight':
          seek(v.currentTime + 5);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setMuted(false);
          setVolume((x) => Math.min(1, Math.round((x + 0.1) * 10) / 10));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setVolume((x) => Math.max(0, Math.round((x - 0.1) * 10) / 10));
          break;
        case 'f':
        case 'F':
          void toggleFullscreen();
          break;
        case 'c':
        case 'C':
          if (cues) setCaptionsOn((x) => !x);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seek, cues]);

  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.playbackRate = speed;
      v.volume = volume;
      v.muted = muted;
    }
  }, [speed, volume, muted]);

  const toggleFullscreen = async () => {
    const el = playerRef.current;
    if (!el) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await el.requestFullscreen();
  };

  const activeCue = useMemo(() => {
    if (!captionsOn || !cues) return null;
    return cues.find((c) => current >= c.start && current <= c.end) ?? null;
  }, [captionsOn, cues, current]);

  const saveTitle = async () => {
    if (titleDraft === null || !meta) return;
    const title = titleDraft.trim();
    setTitleDraft(null);
    if (!title || title === meta.title) return;
    try {
      setMeta(await window.openloom.updateVideo(id, { title }));
      await onChanged();
    } catch (err) {
      push('error', cleanIpcError(err));
    }
  };

  const saveDescription = async () => {
    if (descDraft === null || !meta) return;
    const description = descDraft.trim();
    setDescDraft(null);
    if (description === (meta.description ?? '')) return;
    try {
      setMeta(await window.openloom.updateVideo(id, { description }));
    } catch (err) {
      push('error', cleanIpcError(err));
    }
  };

  if (!meta) return <div className="boot" />;

  const filteredCues =
    cues?.filter((c) => !transcriptQuery.trim() || c.text.toLowerCase().includes(transcriptQuery.toLowerCase())) ?? [];
  const chapters = meta.ai?.chapters ?? [];

  return (
    <div className="watch">
      <header className="view-head watch-head">
        <button type="button" className="icon-btn" aria-label="Back to library" onClick={onBack}>
          <Icon.Back width={17} height={17} />
        </button>
        {titleDraft !== null ? (
          <input
            className="title-edit"
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveTitle();
              if (e.key === 'Escape') setTitleDraft(null);
            }}
            aria-label="Video title"
          />
        ) : (
          <button type="button" className="watch-title" title="Rename" onClick={() => setTitleDraft(meta.title)}>
            {meta.title}
            <Icon.Pencil width={13} height={13} />
          </button>
        )}
        <div className="watch-head-actions">
          <button type="button" className="btn-secondary" onClick={onEdit} title="Trim, cut and stitch">
            <Icon.Scissors width={15} height={15} />
            Edit
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => window.openloom.revealVideo(id)}
            title="Show the MP4 file"
          >
            <Icon.Reveal width={15} height={15} />
            {navigator.platform.toLowerCase().includes('mac') ? 'Reveal in Finder' : 'Show in folder'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={startYouTubePublish}
            title="Publish this recording to YouTube as unlisted"
          >
            <Icon.Play width={15} height={15} />
            Publish to YouTube
          </button>
          <button type="button" className="btn-primary" onClick={() => setShareOpen(true)}>
            <Icon.Link width={15} height={15} />
            {meta.share ? 'Share settings' : 'Share'}
          </button>
        </div>
      </header>

      <div className="watch-body">
        <div className="watch-player-col">
          <div className="player" ref={playerRef}>
            {videoError ? (
              <div className="player-error">
                <Icon.Warning width={28} height={28} />
                <p>{videoError}</p>
              </div>
            ) : (
              <video
                ref={videoRef}
                src={videoUrl}
                onClick={togglePlay}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onTimeUpdate={(e) => setCurrent((e.target as HTMLVideoElement).currentTime)}
                onDurationChange={(e) => setDuration((e.target as HTMLVideoElement).duration || meta.durationSec)}
                onProgress={(e) => {
                  const v = e.target as HTMLVideoElement;
                  const ranges: { start: number; end: number }[] = [];
                  for (let i = 0; i < v.buffered.length; i++) {
                    ranges.push({ start: v.buffered.start(i), end: v.buffered.end(i) });
                  }
                  setBuffered(ranges);
                }}
                onError={() => setVideoError('This video file could not be played. It may still be processing or the file may have moved.')}
              />
            )}

            {!playing && !videoError && (
              <button type="button" className="player-big-play" aria-label="Play" onClick={togglePlay}>
                <Icon.Play width={30} height={30} />
              </button>
            )}

            {activeCue && <div className="player-caption">{activeCue.text}</div>}

            {!videoError && (
              <div className="player-controls">
                <div
                  className="scrubber"
                  role="slider"
                  aria-label="Seek"
                  aria-valuemin={0}
                  aria-valuemax={duration}
                  aria-valuenow={current}
                  tabIndex={0}
                  onMouseMove={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                    setHoverT({ x: e.clientX - rect.left, t: frac * duration });
                  }}
                  onMouseLeave={() => setHoverT(null)}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                    seek(frac * duration);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft') seek(current - 5);
                    if (e.key === 'ArrowRight') seek(current + 5);
                  }}
                >
                  {buffered.map((r, i) => (
                    <div
                      key={i}
                      className="scrubber-buffered"
                      style={{
                        left: `${(r.start / Math.max(duration, 0.01)) * 100}%`,
                        width: `${((r.end - r.start) / Math.max(duration, 0.01)) * 100}%`,
                      }}
                    />
                  ))}
                  <div className="scrubber-played" style={{ width: `${(current / Math.max(duration, 0.01)) * 100}%` }} />
                  {hoverT && (
                    <div className="scrubber-tip" style={{ left: hoverT.x }}>
                      {formatDuration(hoverT.t)}
                    </div>
                  )}
                </div>

                <div className="controls-row">
                  <button type="button" className="ctrl-btn" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
                    {playing ? <Icon.Pause width={17} height={17} /> : <Icon.Play width={17} height={17} />}
                  </button>

                  <span className="time-display">
                    {formatDuration(current)} <span className="time-sep">/</span> {formatDuration(duration)}
                  </span>

                  <div className="controls-spacer" />

                  <div className="speed-wrap">
                    <button type="button" className="ctrl-btn speed-btn" onClick={() => setSpeedOpen((o) => !o)} aria-label="Playback speed">
                      {speed}×
                    </button>
                    {speedOpen && (
                      <div className="speed-menu" role="menu">
                        {SPEEDS.map((s) => (
                          <button
                            key={s}
                            type="button"
                            role="menuitemradio"
                            aria-checked={speed === s}
                            className={speed === s ? 'selected' : ''}
                            onClick={() => {
                              setSpeed(s);
                              setSpeedOpen(false);
                            }}
                          >
                            {s}×
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    className={`ctrl-btn${captionsOn ? ' active' : ''}`}
                    aria-label="Captions"
                    disabled={!cues}
                    title={cues ? 'Captions (C)' : 'No captions yet. Captions appear after transcription.'}
                    onClick={() => setCaptionsOn((x) => !x)}
                  >
                    <Icon.Captions width={17} height={17} />
                  </button>

                  <button type="button" className="ctrl-btn" aria-label={muted ? 'Unmute' : 'Mute'} onClick={() => setMuted((m) => !m)}>
                    {muted || volume === 0 ? <Icon.VolumeMute width={17} height={17} /> : <Icon.Speaker width={17} height={17} />}
                  </button>
                  <input
                    className="volume"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={muted ? 0 : volume}
                    onChange={(e) => {
                      setMuted(false);
                      setVolume(Number(e.target.value));
                    }}
                    aria-label="Volume"
                  />

                  <button type="button" className="ctrl-btn" aria-label="Fullscreen" onClick={() => void toggleFullscreen()}>
                    <Icon.Fullscreen width={17} height={17} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <aside className="watch-side">
          <div className="tabs" role="tablist">
            {(
              [
                ['details', 'Details'],
                ['transcript', 'Transcript'],
                ['chapters', 'Chapters'],
                ['activity', 'Activity'],
              ] as [Tab, string][]
            ).map(([t, label]) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={`tab${tab === t ? ' selected' : ''}`}
                onClick={() => setTab(t)}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'details' && (
            <div className="side-panel">
              <label className="field-label" htmlFor="watch-desc">
                Description
              </label>
              <textarea
                id="watch-desc"
                placeholder="Add a description"
                value={descDraft ?? meta.description ?? ''}
                onChange={(e) => setDescDraft(e.target.value)}
                onBlur={() => void saveDescription()}
                rows={3}
              />
              <dl className="meta-list">
                <div>
                  <dt>Created</dt>
                  <dd>{formatDate(meta.createdAt)}</dd>
                </div>
                <div>
                  <dt>Duration</dt>
                  <dd>{formatDuration(meta.durationSec)}</dd>
                </div>
                <div>
                  <dt>Resolution</dt>
                  <dd>
                    {meta.width}×{meta.height} · {Math.round(meta.fps)} fps
                  </dd>
                </div>
                <div>
                  <dt>Size</dt>
                  <dd>{formatBytes(meta.sizeBytes)}</dd>
                </div>
                <div>
                  <dt>Mode</dt>
                  <dd>
                    {meta.mode === 'screen-cam' ? 'Screen + Camera' : meta.mode === 'screen' ? 'Screen' : 'Camera'}
                  </dd>
                </div>
                <div>
                  <dt>Folder</dt>
                  <dd>{folders.find((f) => f.id === meta.folderId)?.name ?? 'Library'}</dd>
                </div>
                <div>
                  <dt>Sharing</dt>
                  <dd>
                    {meta.share
                      ? meta.share.uploadedAt
                        ? `Shared via ${meta.share.provider}`
                        : `Shared via ${meta.share.provider} - upload not finished`
                      : 'Local only'}
                  </dd>
                </div>
              </dl>
              {meta.share && !meta.share.uploadedAt && (
                <p className="side-note" role="status">
                  The upload did not finish, so this link is not live yet. Retry to make it work.
                </p>
              )}
              {meta.share &&
                (meta.share.uploadedAt ? (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      window.openloom.copyToClipboard(meta.share!.url);
                      push('success', 'Link copied.');
                    }}
                  >
                    <Icon.Link width={15} height={15} />
                    Copy share link
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      push('info', 'Retrying the upload in the background.');
                      void window.openloom
                        .shareVideo(id)
                        .then(() => onChanged())
                        .catch((err) => push('error', cleanIpcError(err)));
                    }}
                  >
                    <Icon.Refresh width={15} height={15} />
                    Retry upload
                  </button>
                ))}

              {(youtubeOpen || meta.youtubeUrl) && (
                <div className="ai-block youtube-block">
                  <div className="ai-block-head">
                    <Icon.Play width={15} height={15} />
                    <h4>Publish to YouTube</h4>
                  </div>

                  {meta.youtubeUrl ? (
                    <>
                      <p className="side-note">This recording is published on YouTube as unlisted.</p>
                      <a
                        className="youtube-link"
                        href={meta.youtubeUrl}
                        onClick={(e) => {
                          e.preventDefault();
                          window.openloom.openExternal(meta.youtubeUrl!);
                        }}
                      >
                        {meta.youtubeUrl}
                      </a>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          window.openloom.copyToClipboard(meta.youtubeUrl!);
                          push('success', 'Link copied.');
                        }}
                      >
                        <Icon.Link width={15} height={15} />
                        Copy YouTube link
                      </button>
                    </>
                  ) : (
                    <>
                      <ol className="youtube-steps">
                        <li>Drop your video - it is revealed in Finder</li>
                        <li>Set Visibility to Unlisted</li>
                        <li>Paste the link below</li>
                      </ol>
                      <label className="field-label" htmlFor="youtube-url">
                        YouTube link
                      </label>
                      <input
                        id="youtube-url"
                        type="url"
                        placeholder="https://www.youtube.com/watch?v=..."
                        value={youtubeDraft}
                        onChange={(e) => {
                          setYoutubeDraft(e.target.value);
                          if (youtubeError) setYoutubeError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveYouTubeLink();
                        }}
                      />
                      {youtubeError && (
                        <p className="youtube-error" role="alert">
                          {youtubeError}
                        </p>
                      )}
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={saveYouTubeLink}
                        disabled={!youtubeDraft.trim()}
                      >
                        Save link
                      </button>
                    </>
                  )}
                </div>
              )}

              {(aiConfigured || meta.ai?.summary || meta.ai?.tasks || meta.ai?.title) && (
                <div className="ai-block">
                  <div className="ai-block-head">
                    <Icon.Sparkle width={15} height={15} />
                    <h4>AI</h4>
                    {aiConfigured && (
                      <button
                        type="button"
                        className="btn-secondary btn-small"
                        disabled={!meta.transcript || runningJob?.kind === 'ai'}
                        title={meta.transcript ? 'Generate from the transcript' : 'Transcribe this video first'}
                        onClick={() =>
                          generateNow(
                            (Object.entries(settings.ai.features) as [string, boolean][])
                              .filter(([, on]) => on)
                              .map(([k]) => k)
                          )
                        }
                      >
                        {meta.ai?.summary || meta.ai?.title ? 'Regenerate' : 'Generate'}
                      </button>
                    )}
                  </div>

                  {meta.ai?.title && meta.ai.title !== meta.title && (
                    <div className="ai-title-suggest">
                      <span className="ai-title-text">{meta.ai.title}</span>
                      <button
                        type="button"
                        className="btn-secondary btn-small"
                        onClick={() =>
                          void window.openloom.updateVideo(id, { title: meta.ai!.title! }).then(
                            (m) => {
                              setMeta(m);
                              void onChanged();
                            },
                            (err) => push('error', cleanIpcError(err))
                          )
                        }
                      >
                        Use as title
                      </button>
                    </div>
                  )}

                  <label className="field-label" htmlFor="ai-summary">
                    Summary
                  </label>
                  <textarea
                    id="ai-summary"
                    placeholder={
                      meta.transcript
                        ? 'No summary yet. Generate one or write your own.'
                        : 'Transcribe this video, then generate a summary.'
                    }
                    value={summaryDraft ?? meta.ai?.summary ?? ''}
                    onChange={(e) => setSummaryDraft(e.target.value)}
                    onBlur={() => {
                      if (summaryDraft !== null && summaryDraft !== (meta.ai?.summary ?? '')) {
                        void saveAi({ summary: summaryDraft });
                      }
                      setSummaryDraft(null);
                    }}
                    rows={3}
                  />

                  <span className="field-label">Action items</span>
                  {(meta.ai?.tasks ?? []).length === 0 ? (
                    <p className="side-note">No action items yet.</p>
                  ) : (
                    <ul className="task-list">
                      {(meta.ai?.tasks ?? []).map((t, i) => (
                        <li key={i} className="task-item">
                          {taskDraft?.index === i ? (
                            <input
                              autoFocus
                              value={taskDraft.text}
                              aria-label="Edit action item"
                              onChange={(e) => setTaskDraft({ index: i, text: e.target.value })}
                              onBlur={() => {
                                const tasks = [...(meta.ai?.tasks ?? [])];
                                if (taskDraft.text.trim()) tasks[i] = taskDraft.text.trim();
                                setTaskDraft(null);
                                void saveAi({ tasks });
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                if (e.key === 'Escape') setTaskDraft(null);
                              }}
                            />
                          ) : (
                            <button
                              type="button"
                              className="task-text"
                              title="Edit"
                              onClick={() => setTaskDraft({ index: i, text: t })}
                            >
                              {t}
                            </button>
                          )}
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label="Remove action item"
                            onClick={() =>
                              void saveAi({ tasks: (meta.ai?.tasks ?? []).filter((_, j) => j !== i) })
                            }
                          >
                            <Icon.Close width={12} height={12} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <button
                type="button"
                className="btn-danger-quiet"
                onClick={() =>
                  void window.openloom.deleteVideo(id).then(onDeleted, (err) => push('error', cleanIpcError(err)))
                }
              >
                <Icon.Trash width={15} height={15} />
                Delete video
              </button>
            </div>
          )}

          {tab === 'transcript' && (
            <div className="side-panel">
              {runningJob?.kind === 'transcribe' && (
                <div className="side-progress" role="status">
                  <span className="spinner" aria-hidden="true" />
                  <span>{runningJob.note ?? 'Transcribing'}</span>
                  <div className="job-bar">
                    <div className="job-bar-fill" style={{ width: `${runningJob.pct}%` }} />
                  </div>
                </div>
              )}
              {cues && cues.length > 0 ? (
                <>
                  <div className="searchbox small">
                    <Icon.Search width={14} height={14} />
                    <input
                      type="search"
                      placeholder="Search transcript"
                      value={transcriptQuery}
                      onChange={(e) => setTranscriptQuery(e.target.value)}
                      aria-label="Search transcript"
                    />
                  </div>
                  <div className="cue-list">
                    {filteredCues.map((c, i) => (
                      <button
                        key={i}
                        type="button"
                        className={`cue${current >= c.start && current <= c.end ? ' current' : ''}`}
                        onClick={() => seek(c.start)}
                      >
                        <span className="cue-time">{formatDuration(c.start)}</span>
                        <span className="cue-text">
                          <HighlightedText text={c.text} query={transcriptQuery} />
                        </span>
                      </button>
                    ))}
                    {filteredCues.length === 0 && <p className="side-note">No transcript lines match.</p>}
                  </div>
                  {transcriptionConfigured && (
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={runningJob?.kind === 'transcribe'}
                      onClick={transcribeNow}
                    >
                      <Icon.Refresh width={14} height={14} />
                      Re-run transcription
                    </button>
                  )}
                </>
              ) : runningJob?.kind === 'transcribe' ? null : (
                <div className="side-empty-state">
                  <Icon.Captions width={30} height={30} />
                  <h4>No transcript yet</h4>
                  {transcriptionConfigured ? (
                    <>
                      <p>Transcribe this video to get clickable, searchable lines and captions in the player.</p>
                      <button type="button" className="btn-primary" onClick={transcribeNow}>
                        Transcribe now
                      </button>
                    </>
                  ) : (
                    <p>
                      Set up a transcription engine in Settings. New recordings are then transcribed automatically
                      and the transcript appears here with clickable, searchable lines.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {tab === 'chapters' && (
            <div className="side-panel">
              {runningJob?.kind === 'ai' && (
                <div className="side-progress" role="status">
                  <span className="spinner" aria-hidden="true" />
                  <span>{runningJob.note ?? 'Generating chapters'}</span>
                </div>
              )}
              {chapters.length > 0 ? (
                <>
                  <div className="cue-list">
                    {chapters.map((c, i) => (
                      <div key={`${c.t}-${i}`} className="chapter-row">
                        {chapterDraft?.index === i ? (
                          <input
                            autoFocus
                            className="chapter-edit"
                            value={chapterDraft.title}
                            aria-label="Chapter title"
                            onChange={(e) => setChapterDraft({ index: i, title: e.target.value })}
                            onBlur={() => {
                              const next = [...chapters];
                              if (chapterDraft.title.trim()) {
                                next[i] = { ...next[i]!, title: chapterDraft.title.trim() };
                              }
                              setChapterDraft(null);
                              void saveAi({ chapters: next });
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                              if (e.key === 'Escape') setChapterDraft(null);
                            }}
                          />
                        ) : (
                          <button type="button" className="cue" onClick={() => seek(c.t)}>
                            <span className="cue-time">{formatDuration(c.t)}</span>
                            <span className="cue-text">{c.title}</span>
                          </button>
                        )}
                        <div className="chapter-actions">
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label="Rename chapter"
                            title="Rename"
                            onClick={() => setChapterDraft({ index: i, title: c.title })}
                          >
                            <Icon.Pencil width={13} height={13} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label="Delete chapter"
                            title="Delete"
                            onClick={() => void saveAi({ chapters: chapters.filter((_, j) => j !== i) })}
                          >
                            <Icon.Close width={12} height={12} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        const t = Math.round(current * 10) / 10;
                        const next = [...chapters, { t, title: `Chapter at ${formatDuration(t)}` }].sort(
                          (a, b) => a.t - b.t
                        );
                        void saveAi({ chapters: next });
                      }}
                    >
                      <Icon.Plus width={14} height={14} />
                      Add at {formatDuration(current)}
                    </button>
                    {aiConfigured && meta.transcript && (
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={runningJob?.kind === 'ai'}
                        onClick={() => generateNow(['chapters'])}
                      >
                        <Icon.Sparkle width={14} height={14} />
                        Regenerate
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <div className="side-empty-state">
                  <Icon.Sparkle width={30} height={30} />
                  <h4>No chapters yet</h4>
                  {aiConfigured && meta.transcript ? (
                    <>
                      <p>Generate chapters from the transcript, or add them by hand at the current time.</p>
                      <div className="btn-row">
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={runningJob?.kind === 'ai'}
                          onClick={() => generateNow(['chapters'])}
                        >
                          Generate chapters
                        </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => {
                            const t = Math.round(current * 10) / 10;
                            void saveAi({ chapters: [{ t, title: `Chapter at ${formatDuration(t)}` }] });
                          }}
                        >
                          Add manually
                        </button>
                      </div>
                    </>
                  ) : aiConfigured ? (
                    <>
                      <p>Chapters are generated from the transcript. Transcribe this video first.</p>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          const t = Math.round(current * 10) / 10;
                          void saveAi({ chapters: [{ t, title: `Chapter at ${formatDuration(t)}` }] });
                        }}
                      >
                        Add manually instead
                      </button>
                    </>
                  ) : (
                    <>
                      <p>
                        Configure an AI provider in Settings to generate chapters from the transcript, or add them
                        by hand at the current time.
                      </p>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          const t = Math.round(current * 10) / 10;
                          void saveAi({ chapters: [{ t, title: `Chapter at ${formatDuration(t)}` }] });
                        }}
                      >
                        Add a chapter at {formatDuration(current)}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {tab === 'activity' && (
            <div className="side-panel">
              <ActivityPanel video={meta} onSeek={seek} />
            </div>
          )}
        </aside>
      </div>

      {shareOpen && (
        <ShareDialog
          video={meta}
          onClose={() => setShareOpen(false)}
          onChange={(fresh) => {
            setMeta(fresh);
            void onChanged();
          }}
          onOpenSharingSettings={() => {
            setShareOpen(false);
            onOpenSharingSettings();
          }}
        />
      )}
    </div>
  );
}
