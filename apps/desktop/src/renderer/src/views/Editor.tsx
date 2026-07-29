/**
 * Editor view (SPEC E1-E4): timeline with filmstrip frames + audio waveform,
 * draggable in/out trim handles, split markers with delete-middle, Add clip
 * (stitch another library video), non-destructive skip preview, and Save that
 * runs the ffmpeg edit jobs (lossless cut vs precise re-encode chosen
 * automatically and surfaced in the progress note). The original stays banked
 * as video.orig.mp4 until the user keeps or reverts the edit.
 *
 * Timeline model: click or drag anywhere scrubs the playhead and selects the
 * section under it; Split cuts at the playhead; Remove/Restore act on the
 * selection; Cut quiet parts marks detected silences as removed. Everything is
 * non-destructive until Save, and every change can be undone (Cmd/Ctrl+Z).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JobProgress, VideoMeta } from '@shared/types';
import { Icon } from '../components/icons';
import { Modal, cleanIpcError, formatDuration, useToasts } from '../components/ui';

interface Seg {
  start: number;
  end: number;
  kept: boolean;
}

const MIN_SEG = 0.1;

function mergeKept(segs: Seg[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const s of segs) {
    if (!s.kept) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.end - s.start) < 0.001) last.end = s.end;
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

function totalKept(segs: Seg[]): number {
  return segs.reduce((sum, s) => sum + (s.kept ? s.end - s.start : 0), 0);
}

/**
 * Mark this edge's own leading ('in') or trailing ('out') removed run as kept,
 * undoing the current trim so a handle can be dragged back out again. Stops at
 * the first kept segment, so interior cuts made by split/remove are preserved.
 */
export function restoreEdgeRun(segs: Seg[], edge: 'in' | 'out'): Seg[] {
  const out = segs.map((s) => ({ ...s }));
  const order = edge === 'in' ? out : [...out].reverse();
  for (const s of order) {
    if (s.kept) break;
    s.kept = true;
  }
  return out;
}

/** Collapse touching segments that share a kept state, so drags do not fragment. */
export function mergeAdjacent(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.kept === s.kept && Math.abs(last.end - s.start) < 0.001) last.end = s.end;
    else out.push({ ...s });
  }
  return out;
}

/** Breathing room kept around speech when cutting a quiet stretch, so words are not clipped. */
export const SILENCE_PAD = 0.18;
/** A quiet stretch must still be at least this long after padding to be worth cutting. */
export const MIN_SILENCE_CUT = 0.4;

/**
 * Mark detected quiet stretches as removed sections, shrunk by SILENCE_PAD on
 * both sides. Only kept parts are touched, so existing cuts survive, and the
 * whole edit is refused when it would leave less than a second of video.
 */
export function cutQuietParts(
  segs: Seg[],
  silences: { start: number; end: number }[]
): { segs: Seg[]; cutCount: number; removedSec: number } {
  let out = segs.map((s) => ({ ...s }));
  let cutCount = 0;
  for (const sil of silences) {
    const start = sil.start + SILENCE_PAD;
    const end = sil.end - SILENCE_PAD;
    if (end - start < MIN_SILENCE_CUT) continue;
    const next: Seg[] = [];
    let cutThis = false;
    for (const s of out) {
      if (!s.kept || s.end <= start || s.start >= end) {
        next.push(s);
        continue;
      }
      const a = Math.max(s.start, start);
      const b = Math.min(s.end, end);
      if (b - a < 0.01) {
        next.push(s);
        continue;
      }
      cutThis = true;
      if (a - s.start > 0.001) next.push({ start: s.start, end: a, kept: true });
      next.push({ start: a, end: b, kept: false });
      if (s.end - b > 0.001) next.push({ start: b, end: s.end, kept: true });
    }
    if (cutThis) {
      cutCount++;
      out = next;
    }
  }
  out = mergeAdjacent(out);
  if (cutCount === 0 || totalKept(out) < 1) {
    return { segs, cutCount: 0, removedSec: 0 };
  }
  return { segs: out, cutCount, removedSec: totalKept(segs) - totalKept(out) };
}

const FILMSTRIP_FRAMES = 14;

export function EditorView({
  id,
  onBack,
  onChanged,
}: {
  id: string;
  onBack: () => void;
  onChanged: () => Promise<void>;
}) {
  const { push } = useToasts();
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [segs, setSegs] = useState<Seg[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [frames, setFrames] = useState<string[]>([]);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [job, setJob] = useState<JobProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [libraryVideos, setLibraryVideos] = useState<VideoMeta[]>([]);
  const [savedBanner, setSavedBanner] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [history, setHistory] = useState<Seg[][]>([]);
  const [detecting, setDetecting] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  // Bumped after every save so <video>/filmstrip reload the changed file.
  const [fileVersion, setFileVersion] = useState(0);

  const duration = meta?.durationSec ?? 0;
  const videoUrl = useMemo(
    () => `${window.openloom.fileUrl(id, 'video.mp4')}?v=${fileVersion}`,
    [id, fileVersion]
  );
  const posterUrl = useMemo(
    () => `${window.openloom.fileUrl(id, 'thumb.jpg')}?v=${fileVersion}`,
    [id, fileVersion]
  );

  // Keep the raw video surface hidden until it has decodable frames (it
  // renders green garbage before then); the skeleton covers the wait.
  useEffect(() => {
    setVideoReady(false);
  }, [videoUrl]);

  const resetSegs = useCallback((dur: number) => {
    setSegs([{ start: 0, end: dur, kept: true }]);
    setSelected(null);
    setHistory([]);
  }, []);

  const loadMeta = useCallback(async () => {
    const m = await window.openloom.getVideo(id);
    setMeta(m);
    resetSegs(m.durationSec);
    return m;
  }, [id, resetSegs]);

  useEffect(() => {
    void loadMeta().catch((err) => push('error', cleanIpcError(err)));
  }, [loadMeta, push]);

  // Waveform peaks (reuses the processing-time waveform.json).
  useEffect(() => {
    let cancelled = false;
    void fetch(`${window.openloom.fileUrl(id, 'waveform.json')}?v=${fileVersion}`)
      .then(async (res) => (res.ok ? ((await res.json()) as { peaks?: number[] }) : null))
      .then((data) => {
        if (!cancelled) setPeaks(data?.peaks ?? []);
      })
      .catch(() => {
        if (!cancelled) setPeaks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [id, fileVersion]);

  // Filmstrip: seek a hidden video through evenly spaced times, draw frames.
  useEffect(() => {
    if (!duration) return;
    let cancelled = false;
    const extractor = document.createElement('video');
    extractor.muted = true;
    extractor.preload = 'auto';
    // CORS mode keeps the canvas untainted so frames can be read back.
    extractor.crossOrigin = 'anonymous';
    extractor.src = videoUrl;
    const canvas = document.createElement('canvas');

    const grab = (t: number) =>
      new Promise<string | null>((resolve) => {
        const onSeeked = () => {
          extractor.removeEventListener('seeked', onSeeked);
          try {
            const w = 168;
            const h = Math.max(1, Math.round((extractor.videoHeight / Math.max(1, extractor.videoWidth)) * w));
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx) return resolve(null);
            ctx.drawImage(extractor, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', 0.6));
          } catch {
            resolve(null);
          }
        };
        extractor.addEventListener('seeked', onSeeked);
        extractor.currentTime = Math.min(t, Math.max(0, duration - 0.05));
      });

    const run = async () => {
      await new Promise<void>((resolve, reject) => {
        extractor.addEventListener('loadedmetadata', () => resolve(), { once: true });
        extractor.addEventListener('error', () => reject(new Error('load failed')), { once: true });
      });
      const out: string[] = [];
      for (let i = 0; i < FILMSTRIP_FRAMES; i++) {
        if (cancelled) return;
        const t = (duration * (i + 0.5)) / FILMSTRIP_FRAMES;
        const frame = await grab(t);
        out.push(frame ?? '');
        if (!cancelled) setFrames([...out]);
      }
    };
    setFrames([]);
    void run().catch(() => undefined);
    return () => {
      cancelled = true;
      extractor.removeAttribute('src');
      extractor.load();
    };
  }, [videoUrl, duration]);

  // Waveform canvas painting.
  useEffect(() => {
    const canvas = waveRef.current;
    if (!canvas) return;
    const paint = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (peaks.length === 0) return;
      const style = getComputedStyle(document.documentElement);
      ctx.fillStyle = style.getPropertyValue('--ol-accent').trim() || '#635BFF';
      ctx.globalAlpha = 0.55;
      const mid = canvas.height / 2;
      const barW = canvas.width / peaks.length;
      for (let i = 0; i < peaks.length; i++) {
        const h = Math.max(1, peaks[i]! * (canvas.height * 0.92));
        ctx.fillRect(i * barW, mid - h / 2, Math.max(1, barW * 0.8), h);
      }
    };
    paint();
    const obs = new ResizeObserver(paint);
    obs.observe(canvas);
    return () => obs.disconnect();
  }, [peaks]);

  // Smooth playhead while playing.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) setCurrent(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // Non-destructive preview: skip removed sections during playback (E1).
  const keptRanges = useMemo(() => mergeKept(segs), [segs]);
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !playing || keptRanges.length === 0) return;
    const t = current;
    const inKept = keptRanges.some((r) => t >= r.start - 0.02 && t <= r.end + 0.02);
    if (inKept) return;
    const next = keptRanges.find((r) => r.start > t);
    if (next) {
      v.currentTime = next.start + 0.01;
    } else {
      v.pause();
      v.currentTime = keptRanges[keptRanges.length - 1]!.end - 0.01;
    }
  }, [current, playing, keptRanges]);

  // Edit job progress for this video.
  useEffect(() => {
    return window.openloom.onJobProgress((j) => {
      if (j.videoId !== id) return;
      if (['trim', 'stitch', 'revert', 'thumbnail', 'gif', 'waveform'].includes(j.kind)) {
        setJob(j.pct >= 100 && ['thumbnail', 'gif', 'waveform'].includes(j.kind) ? null : j);
      }
    });
  }, [id]);

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    const clamped = Math.max(0, Math.min(t, v.duration || t));
    v.currentTime = clamped;
    setCurrent(clamped);
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      // Start inside the first kept range so previews reflect the edit.
      if (keptRanges.length > 0 && (v.currentTime < keptRanges[0]!.start || v.currentTime >= keptRanges[keptRanges.length - 1]!.end - 0.05)) {
        v.currentTime = keptRanges[0]!.start;
      }
      void v.play().catch(() => undefined);
    } else {
      v.pause();
    }
  }, [keptRanges]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        undo();
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      }
      if (e.key === 's' || e.key === 'S') splitAtPlayhead();
      if ((e.key === 'Backspace' || e.key === 'Delete') && selected !== null) {
        if (segs[selected]?.kept) removeSegment(selected);
        else restoreSegment(selected);
      }
      // Nudge the playhead for precise cuts; trim handles keep their own arrows.
      if (!target.closest?.('.tl-handle')) {
        if (e.key === 'ArrowLeft') seek(current - (e.shiftKey ? 1 : 0.1));
        if (e.key === 'ArrowRight') seek(current + (e.shiftKey ? 1 : 0.1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // --- segment operations ---------------------------------------------------

  /** Apply a new segment layout, remembering the old one for undo. */
  const applySegs = (next: Seg[]) => {
    setHistory((h) => [...h.slice(-49), segs]);
    setSegs(next);
    setSelected(null);
  };

  const undo = useCallback(() => {
    setHistory((h) => {
      const prev = h[h.length - 1];
      if (prev) {
        setSegs(prev);
        setSelected(null);
      }
      return h.slice(0, -1);
    });
  }, []);

  const splitAtPlayhead = () => {
    const t = videoRef.current?.currentTime ?? current;
    const idx = segs.findIndex((s) => t > s.start + MIN_SEG && t < s.end - MIN_SEG);
    if (idx < 0) return;
    const s = segs[idx]!;
    const next = [...segs];
    next.splice(idx, 1, { start: s.start, end: t, kept: s.kept }, { start: t, end: s.end, kept: s.kept });
    applySegs(next);
  };

  const removeSegment = (i: number) => {
    if (!segs[i]) return;
    const next = segs.map((s, idx) => (idx === i ? { ...s, kept: false } : s));
    if (totalKept(next) < MIN_SEG) {
      push('error', 'At least one section must remain.');
      return;
    }
    applySegs(next);
  };

  const restoreSegment = (i: number) => {
    applySegs(segs.map((s, idx) => (idx === i ? { ...s, kept: true } : s)));
  };

  /** Detect silences in the audio and mark them as removed sections (non-destructive). */
  const cutSilences = async () => {
    if (detecting || busy) return;
    setDetecting(true);
    try {
      const silences = await window.openloom.detectSilences(id);
      const result = cutQuietParts(segs, silences);
      if (result.cutCount === 0) {
        push('info', 'No quiet parts found. Nothing was cut.');
        return;
      }
      applySegs(result.segs);
      push(
        'success',
        `Cut ${result.cutCount} quiet ${result.cutCount === 1 ? 'part' : 'parts'} - ${formatDuration(result.removedSec)} shorter. Check the preview, then save.`
      );
    } catch (err) {
      push('error', cleanIpcError(err));
    } finally {
      setDetecting(false);
    }
  };

  /**
   * Trim handles: everything before/after t becomes a removed section.
   *
   * The handle re-places its own boundary, so it has to move both ways. Cutting
   * straight from the current segments made every drag additive - an already
   * removed head just got split, never shrunk, so dragging a handle back to
   * widen the keep-range (or nudging it with an arrow key) did nothing at all.
   * Restore this edge's own removed run first, then cut at the new position.
   * Interior removed sections, which belong to split/remove, are left alone.
   */
  const applyTrim = (edge: 'in' | 'out', t: number) => {
    setSegs((prevRaw) => {
      const prev = restoreEdgeRun(prevRaw, edge);
      const dur = prev.length > 0 ? prev[prev.length - 1]!.end : duration;
      const clamped = Math.max(0, Math.min(t, dur));
      const out: Seg[] = [];
      if (edge === 'in') {
        if (clamped > MIN_SEG) out.push({ start: 0, end: clamped, kept: false });
        for (const s of prev) {
          if (s.end <= clamped) continue;
          const start = Math.max(s.start, clamped);
          if (s.end - start < 0.01) continue;
          out.push({ start, end: s.end, kept: s.kept });
        }
        if (out.every((s) => !s.kept)) return prevRaw;
      } else {
        for (const s of prev) {
          if (s.start >= clamped) continue;
          const end = Math.min(s.end, clamped);
          if (end - s.start < 0.01) continue;
          out.push({ start: s.start, end, kept: s.kept });
        }
        if (clamped < dur - MIN_SEG) out.push({ start: clamped, end: dur, kept: false });
        if (out.every((s) => !s.kept)) return prevRaw;
      }
      return mergeAdjacent(out);
    });
  };

  const trimIn = keptRanges[0]?.start ?? 0;
  const trimOut = keptRanges[keptRanges.length - 1]?.end ?? duration;

  // --- timeline pointer handling ---------------------------------------------

  const timeAtClientX = (clientX: number): number => {
    const el = timelineRef.current;
    if (!el || duration === 0) return 0;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * duration;
  };

  const dragHandle = (edge: 'in' | 'out') => (downEvent: React.PointerEvent) => {
    downEvent.preventDefault();
    downEvent.stopPropagation();
    // One undo step per drag, not per pointer move.
    setHistory((h) => [...h.slice(-49), segs]);
    const move = (e: PointerEvent) => {
      const t = timeAtClientX(e.clientX);
      applyTrim(edge, t);
      seek(t);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /**
   * Click or drag anywhere on the timeline to scrub. The section under the
   * pointer becomes the selection, so cut-then-remove is: click, S, click, Remove.
   */
  const scrubTimeline = (downEvent: React.PointerEvent) => {
    if ((downEvent.target as HTMLElement).closest('.tl-handle')) return;
    const selectAt = (clientX: number) => {
      const t = timeAtClientX(clientX);
      seek(t);
      const idx = segs.findIndex((s) => t >= s.start && t < s.end);
      setSelected(idx >= 0 ? idx : null);
    };
    selectAt(downEvent.clientX);
    const move = (e: PointerEvent) => selectAt(e.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // --- actions ----------------------------------------------------------------

  const isEdited =
    keptRanges.length > 1 ||
    (keptRanges.length === 1 && (keptRanges[0]!.start > 0.01 || keptRanges[0]!.end < duration - 0.01));

  const save = async () => {
    if (!isEdited || busy) return;
    setBusy(true);
    videoRef.current?.pause();
    try {
      await window.openloom.trimVideo(id, keptRanges.map((r) => ({ start: r.start, end: r.end })));
      const m = await loadMeta();
      setFileVersion((v) => v + 1);
      setCurrent(0);
      setSavedBanner(true);
      await onChanged();
      push('success', `Saved. New length ${formatDuration(m.durationSec)}.`);
    } catch (err) {
      push('error', cleanIpcError(err));
    } finally {
      setBusy(false);
      setJob(null);
    }
  };

  const openAddClip = async () => {
    try {
      const all = await window.openloom.listVideos();
      setLibraryVideos(all.filter((v) => v.id !== id));
      setAddOpen(true);
    } catch (err) {
      push('error', cleanIpcError(err));
    }
  };

  const addClip = async (appendId: string) => {
    setAddOpen(false);
    setBusy(true);
    videoRef.current?.pause();
    try {
      await window.openloom.stitchVideos(id, appendId);
      const m = await loadMeta();
      setFileVersion((v) => v + 1);
      setSavedBanner(true);
      await onChanged();
      push('success', `Clip added. New length ${formatDuration(m.durationSec)}.`);
    } catch (err) {
      push('error', cleanIpcError(err));
    } finally {
      setBusy(false);
      setJob(null);
    }
  };

  const revert = async () => {
    setBusy(true);
    videoRef.current?.pause();
    try {
      await window.openloom.revertEdits(id);
      await loadMeta();
      setFileVersion((v) => v + 1);
      setSavedBanner(false);
      await onChanged();
      push('success', 'Original restored.');
    } catch (err) {
      push('error', cleanIpcError(err));
    } finally {
      setBusy(false);
      setJob(null);
    }
  };

  const keepEdit = async () => {
    try {
      await window.openloom.confirmEdits(id);
      await loadMeta();
      setSavedBanner(false);
      push('success', 'Edit kept. The original file was removed.');
    } catch (err) {
      push('error', cleanIpcError(err));
    }
  };

  const retranscribe = () => {
    void window.openloom.transcribeVideo(id).then(
      () => push('success', 'Transcript updated for the edited video.'),
      (err) => push('error', cleanIpcError(err))
    );
    push('info', 'Re-running transcription in the background.');
  };

  if (!meta) return <div className="boot" />;

  const hasBankedOriginal = Boolean(meta.edits?.trimmedFrom);
  const pct = (t: number) => `${(t / Math.max(duration, 0.01)) * 100}%`;

  return (
    <div className="editor">
      <header className="view-head watch-head">
        <button type="button" className="icon-btn" aria-label="Back to video" onClick={onBack}>
          <Icon.Back width={17} height={17} />
        </button>
        <h2 className="editor-title">
          Edit <span className="editor-title-name">{meta.title}</span>
        </h2>
        <div className="watch-head-actions">
          <button type="button" className="btn-secondary" onClick={() => void openAddClip()} disabled={busy}>
            <Icon.Plus width={15} height={15} />
            Add clip
          </button>
          <button type="button" className="btn-primary" onClick={() => void save()} disabled={!isEdited || busy}>
            <Icon.Check width={15} height={15} />
            Save edit
          </button>
        </div>
      </header>

      {(savedBanner || hasBankedOriginal) && !busy && (
        <div className="edit-banner">
          <Icon.Clock width={15} height={15} />
          <span>
            The original video is kept until you decide. Keep this edit, or restore the original.
          </span>
          {meta.transcript && (
            <button type="button" className="btn-secondary" onClick={retranscribe}>
              Update transcript
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={() => void revert()}>
            <Icon.Undo width={14} height={14} />
            Revert
          </button>
          <button type="button" className="btn-primary" onClick={() => void keepEdit()}>
            Keep edit
          </button>
        </div>
      )}

      <div className="editor-player">
        {videoError ? (
          <div className="player-error">
            <Icon.Warning width={28} height={28} />
            <p>{videoError}</p>
            <div className="player-error-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setVideoError(null);
                  setFileVersion((v) => v + 1);
                }}
              >
                <Icon.Refresh width={15} height={15} />
                Try again
              </button>
            </div>
          </div>
        ) : (
          <>
            {!videoReady && <div className="player-skeleton" aria-hidden="true" />}
            <video
              ref={videoRef}
              className={videoReady ? 'ready' : ''}
              src={videoUrl}
              poster={posterUrl}
              preload="auto"
              onClick={togglePlay}
              onLoadedData={() => setVideoReady(true)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onTimeUpdate={(e) => setCurrent((e.target as HTMLVideoElement).currentTime)}
              onError={() => setVideoError('This video file could not be loaded for editing.')}
            />
          </>
        )}
        {!playing && !videoError && videoReady && (
          <button type="button" className="player-big-play" aria-label="Play preview" onClick={togglePlay}>
            <Icon.Play width={30} height={30} />
          </button>
        )}
      </div>

      <div className="editor-toolbar">
        <button type="button" className="ctrl-btn" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
          {playing ? <Icon.Pause width={17} height={17} /> : <Icon.Play width={17} height={17} />}
        </button>
        <span className="time-display">
          {formatDuration(current)} <span className="time-sep">/</span> {formatDuration(duration)}
        </span>
        <button
          type="button"
          className="icon-btn"
          aria-label="Undo the last edit step"
          title="Undo (Cmd+Z)"
          disabled={history.length === 0 || busy}
          onClick={undo}
        >
          <Icon.Undo width={15} height={15} />
        </button>
        <div className="controls-spacer" />
        <span className="editor-result-len" title="Length after this edit">
          Result: {formatDuration(totalKept(segs))}
        </span>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void cutSilences()}
          disabled={detecting || busy}
          title="Find silent stretches and cut them all out in one go"
        >
          <Icon.VolumeMute width={15} height={15} />
          {detecting ? 'Listening…' : 'Remove quiet parts'}
        </button>
        <button type="button" className="btn-secondary" onClick={splitAtPlayhead} title="Split at the playhead (S)">
          <Icon.Split width={15} height={15} />
          Split
        </button>
        {selected !== null && segs[selected] && !segs[selected]!.kept ? (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => restoreSegment(selected)}
            title="Bring the selected section back (Delete)"
          >
            <Icon.Undo width={15} height={15} />
            Restore section
          </button>
        ) : (
          <button
            type="button"
            className="btn-danger-quiet"
            disabled={selected === null || !segs[selected]?.kept}
            onClick={() => selected !== null && removeSegment(selected)}
            title="Remove the selected section (Delete)"
          >
            <Icon.Trash width={15} height={15} />
            Remove section
          </button>
        )}
      </div>

      <div
        className="timeline"
        ref={timelineRef}
        role="group"
        aria-label="Edit timeline"
        onPointerDown={scrubTimeline}
      >
        <div className="filmstrip" aria-hidden="true">
          {Array.from({ length: FILMSTRIP_FRAMES }, (_, i) => (
            <div key={i} className="filmstrip-frame">
              {frames[i] ? <img src={frames[i]} alt="" draggable={false} /> : <div className="filmstrip-blank" />}
            </div>
          ))}
        </div>
        <canvas ref={waveRef} className="wave-canvas" aria-hidden="true" />
        {peaks.length === 0 && <span className="wave-none">No audio track</span>}

        {/* removed/kept shading; all pointer handling lives on the timeline itself */}
        <div className="tl-segments" aria-hidden="true">
          {segs.map((s, i) => (
            <div
              key={`${s.start.toFixed(3)}-${s.end.toFixed(3)}`}
              className={`tl-seg${s.kept ? '' : ' removed'}${selected === i ? ' selected' : ''}`}
              style={{ left: pct(s.start), width: pct(s.end - s.start) }}
              title={
                s.kept
                  ? `Kept ${formatDuration(s.start)} to ${formatDuration(s.end)}.`
                  : `Removed ${formatDuration(s.start)} to ${formatDuration(s.end)}. Click it, then Restore section.`
              }
            />
          ))}
        </div>

        {/* split markers */}
        {segs.slice(1).map((s) =>
          s.start > trimIn + 0.01 && s.start < trimOut - 0.01 ? (
            <div key={`cut-${s.start.toFixed(3)}`} className="tl-cut" style={{ left: pct(s.start) }} aria-hidden="true" />
          ) : null
        )}

        {/* trim handles */}
        <div
          className="tl-handle in"
          style={{ left: pct(trimIn) }}
          role="slider"
          aria-label="Trim start"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={trimIn}
          tabIndex={0}
          onPointerDown={dragHandle('in')}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') applyTrim('in', trimIn - 0.5);
            if (e.key === 'ArrowRight') applyTrim('in', trimIn + 0.5);
          }}
        />
        <div
          className="tl-handle out"
          style={{ left: pct(trimOut) }}
          role="slider"
          aria-label="Trim end"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={trimOut}
          tabIndex={0}
          onPointerDown={dragHandle('out')}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') applyTrim('out', trimOut - 0.5);
            if (e.key === 'ArrowRight') applyTrim('out', trimOut + 0.5);
          }}
        />

        <div className="tl-playhead" style={{ left: pct(current) }} aria-hidden="true" />
      </div>

      <p className="editor-hint">
        Click anywhere on the timeline to move the playhead (arrow keys nudge it). Press S to split there, then
        Remove the part you do not want - click a removed part to bring it back with Restore. Drag the handles to
        trim the ends. Nothing touches the file until you press Save, and Cmd+Z undoes any step.
      </p>

      {(busy || job) && (
        <div className="job-overlay" role="status" aria-live="polite">
          <div className="job-card">
            <span className="spinner" aria-hidden="true" />
            <div className="job-text">
              <strong>{job?.note ?? 'Working on the edit'}</strong>
              <div className="job-bar">
                <div className="job-bar-fill" style={{ width: `${job?.pct ?? 5}%` }} />
              </div>
            </div>
          </div>
        </div>
      )}

      {addOpen && (
        <Modal title="Add a clip to the end" onClose={() => setAddOpen(false)} width={520}>
          {libraryVideos.length === 0 ? (
            <div className="side-empty-state">
              <Icon.Library width={30} height={30} />
              <h4>No other videos</h4>
              <p>Record another video first, then stitch it onto this one here.</p>
            </div>
          ) : (
            <div className="add-clip-list">
              {libraryVideos.map((v) => (
                <button key={v.id} type="button" className="add-clip-item" onClick={() => void addClip(v.id)}>
                  <img src={window.openloom.fileUrl(v.id, 'thumb.jpg')} alt="" draggable={false} />
                  <span className="add-clip-text">
                    <strong>{v.title}</strong>
                    <span>
                      {formatDuration(v.durationSec)} · {v.width}×{v.height}
                    </span>
                  </span>
                  <Icon.Plus width={16} height={16} />
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
