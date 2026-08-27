/**
 * Editor view (SPEC E1-E4): timeline with filmstrip frames + audio waveform,
 * draggable in/out trim handles, split markers with delete-middle, drag-to-cut
 * (drag across a part, one button removes it), Add clip (stitch another
 * library video), "End it here, film the rest" (trim at the playhead, record a
 * matching continuation take, offer the join when it lands), non-destructive
 * skip preview, and Save that runs the ffmpeg edit jobs (lossless cut vs
 * precise re-encode chosen automatically and surfaced in the progress note).
 * The original stays banked as video.orig.mp4 until the user keeps or reverts.
 *
 * Timeline model: click scrubs the playhead and selects the section under it;
 * dragging paints a removal range; Split cuts at the playhead; Remove/Restore
 * act on the selection; Cut quiet parts marks detected silences as removed.
 * Everything is non-destructive until Save (Cmd/Ctrl+S), every change can be
 * undone (Cmd/Ctrl+Z), and leaving with unsaved cuts asks first.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JobProgress, VideoMeta } from '@shared/types';
import { Icon } from '../components/icons';
import { Modal, cleanIpcError, formatBytes, formatDuration, useToasts } from '../components/ui';

interface Seg {
  start: number;
  end: number;
  kept: boolean;
}

const MIN_SEG = 0.1;

/**
 * Mirrors WAVEFORM_VERSION in the main process. Waveforms written before this
 * used peak-max on a linear scale, which drew transients rather than speech, so
 * anything older is rebuilt on open.
 */
const CURRENT_WAVEFORM_VERSION = 2;

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

/**
 * Re-place a trim edge at time t (pure core of the handle drag and of "End it
 * here"). The handle re-places its own boundary, so it has to move both ways:
 * cutting straight from the current segments made every drag additive - an
 * already removed head just got split, never shrunk. Restore this edge's own
 * removed run first, then cut at the new position. Interior removed sections,
 * which belong to split/remove, are left alone. Returns the input unchanged
 * when the move would leave nothing kept.
 */
export function trimEdgeAt(prevRaw: Seg[], edge: 'in' | 'out', t: number, duration: number): Seg[] {
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
}

/**
 * Remove [start, end] from the kept timeline in one step: the drag-to-cut
 * equivalent of split + split + remove-middle. Only kept segments are touched,
 * so existing cuts survive. Null when the range removes nothing, or when the
 * cut would leave less than MIN_SEG of video.
 */
export function cutRange(
  segs: Seg[],
  start: number,
  end: number
): { segs: Seg[]; removedSec: number } | null {
  if (end - start < 0.01) return null;
  const next: Seg[] = [];
  let cut = false;
  for (const s of segs) {
    if (!s.kept || s.end <= start || s.start >= end) {
      next.push({ ...s });
      continue;
    }
    const a = Math.max(s.start, start);
    const b = Math.min(s.end, end);
    if (b - a < 0.01) {
      next.push({ ...s });
      continue;
    }
    cut = true;
    if (a - s.start > 0.001) next.push({ start: s.start, end: a, kept: true });
    next.push({ start: a, end: b, kept: false });
    if (s.end - b > 0.001) next.push({ start: b, end: s.end, kept: true });
  }
  if (!cut) return null;
  const merged = mergeAdjacent(next);
  if (totalKept(merged) < MIN_SEG) return null;
  return { segs: merged, removedSec: totalKept(segs) - totalKept(merged) };
}

/** True when the kept ranges differ from the untouched full-length video. */
export function rangesEdited(ranges: { start: number; end: number }[], duration: number): boolean {
  return (
    ranges.length > 1 ||
    (ranges.length === 1 && (ranges[0]!.start > 0.01 || ranges[0]!.end < duration - 0.01))
  );
}

/**
 * Plain-English summary of the accumulated edits, so the keep/revert surfaces
 * can say what they act on instead of "this edit".
 */
export function describeEdits(history?: { kind: 'trim' | 'stitch' }[]): string {
  const trims = history?.filter((h) => h.kind === 'trim').length ?? 0;
  const stitches = history?.filter((h) => h.kind === 'stitch').length ?? 0;
  const parts: string[] = [];
  if (trims === 1) parts.push('a trim');
  else if (trims > 1) parts.push(`${trims} trims`);
  if (stitches === 1) parts.push('an added clip');
  else if (stitches > 1) parts.push(`${stitches} added clips`);
  return parts.length > 0 ? parts.join(' and ') : 'your changes';
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

/** Drags shorter than this many pixels count as clicks, not range selections. */
const DRAG_THRESHOLD_PX = 5;
/** A painted range shorter than this is discarded on release (accidental wiggle). */
const MIN_RANGE_SEC = 0.2;

export function EditorView({
  id,
  onBack,
  onChanged,
  onDirtyChange,
  leaveRequested,
  onLeaveResolved,
}: {
  id: string;
  onBack: () => void;
  onChanged: () => Promise<void>;
  /** Reports whether unsaved cuts exist, so the shell can guard navigation. */
  onDirtyChange?: (dirty: boolean) => void;
  /** The shell wants to navigate away; the editor confirms or waves it through. */
  leaveRequested?: boolean;
  onLeaveResolved?: (leave: boolean) => void;
}) {
  const { push } = useToasts();
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [segs, setSegs] = useState<Seg[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [rangeSel, setRangeSel] = useState<{ start: number; end: number } | null>(null);
  const [frames, setFrames] = useState<string[]>([]);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [job, setJob] = useState<JobProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [libraryVideos, setLibraryVideos] = useState<VideoMeta[]>([]);
  const [savedBanner, setSavedBanner] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [history, setHistory] = useState<Seg[][]>([]);
  const [detecting, setDetecting] = useState(false);
  // 'back' = the editor's own Back button, 'nav' = the shell asked to leave,
  // 'close' = the window is closing. All three show the same unsaved-cuts modal.
  const [confirmLeave, setConfirmLeave] = useState<'back' | 'nav' | 'close' | null>(null);
  const [confirmAction, setConfirmAction] = useState<'keep' | 'revert' | null>(null);
  // A continuation is armed: the next recording comes back here to be joined.
  const [armed, setArmed] = useState(false);
  // Metadata of the recorded continuation take, once one is waiting.
  const [take, setTake] = useState<VideoMeta | null>(null);
  const [updatingShare, setUpdatingShare] = useState(false);

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
    setRangeSel(null);
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

  // The waiting continuation take, when there is one. A take that has been
  // deleted from the library clears the offer rather than dangling forever.
  useEffect(() => {
    const takeId = meta?.continuation?.takeId;
    if (!takeId) {
      setTake(null);
      return;
    }
    let cancelled = false;
    window.openloom.getVideo(takeId).then(
      (m) => {
        if (!cancelled) setTake(m);
      },
      () => {
        if (!cancelled) {
          setTake(null);
          void window.openloom.dismissContinuation(id).catch(() => undefined);
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [meta?.continuation?.takeId, id]);

  // Waveform peaks (reuses the processing-time waveform.json).
  useEffect(() => {
    let cancelled = false;
    // Recordings made before the waveform was reworked carry no version and a
    // peak-max envelope, which renders as spiky bars next to the smooth one.
    // Rather than leave the old library looking broken, redraw what we have and
    // rebuild it in the background, then show the result.
    const load = async (): Promise<void> => {
      const url = `${window.openloom.fileUrl(id, 'waveform.json')}?v=${fileVersion}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { peaks?: number[]; version?: number };
        if (cancelled) return;
        setPeaks(data.peaks ?? []);
        if ((data.version ?? 1) >= CURRENT_WAVEFORM_VERSION) return;
      } else {
        // A waveform that was never generated (processing hiccup, imported
        // file) gets the same background self-heal as an outdated one -
        // otherwise a video WITH sound wears "No audio track" forever.
        if (cancelled) return;
        setPeaks([]);
      }

      await window.openloom.regeneratePreviews(id);
      if (cancelled) return;
      const fresh = await fetch(`${url}&w=${Date.now()}`);
      if (!fresh.ok || cancelled) return;
      const next = (await fresh.json()) as { peaks?: number[] };
      if (!cancelled) setPeaks(next.peaks ?? []);
    };
    void load().catch(() => {
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
      const accent = style.getPropertyValue('--ol-accent').trim() || '#635BFF';
      const mid = canvas.height / 2;
      const maxH = canvas.height * 0.92;

      // A filled envelope mirrored about the centre line, not a bar per bucket.
      // Bars read as a chart of transients; a continuous shape reads as a voice.
      // The path is built along the top edge and back along the bottom, with a
      // quadratic through the midpoint of each pair of samples so the outline
      // stays smooth however many buckets the recording produced.
      const x = (i: number) => (i / (peaks.length - 1 || 1)) * canvas.width;
      const top = (i: number) => mid - Math.max(0.5, peaks[i]! * maxH) / 2;
      const bottom = (i: number) => mid + Math.max(0.5, peaks[i]! * maxH) / 2;

      const trace = (edge: (i: number) => number, forward: boolean) => {
        const idx = forward
          ? peaks.map((_, i) => i)
          : peaks.map((_, i) => peaks.length - 1 - i);
        for (let k = 0; k < idx.length - 1; k++) {
          const i = idx[k]!;
          const next = idx[k + 1]!;
          const midX = (x(i) + x(next)) / 2;
          const midY = (edge(i) + edge(next)) / 2;
          ctx.quadraticCurveTo(x(i), edge(i), midX, midY);
        }
        const last = idx[idx.length - 1]!;
        ctx.lineTo(x(last), edge(last));
      };

      ctx.beginPath();
      ctx.moveTo(x(0), top(0));
      trace(top, true);
      trace(bottom, false);
      ctx.closePath();
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.5;
      ctx.fill();
      // A crisper outline keeps quiet passages legible, where the fill is thin.
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = Math.max(1, dpr);
      ctx.strokeStyle = accent;
      ctx.stroke();
      ctx.globalAlpha = 1;
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
      // Only file-mutating jobs raise the blocking overlay. Preview kinds
      // (thumbnail/gif/waveform) also run as BACKGROUND rebuilds - the
      // waveform self-heal fires one on open - and surfacing those froze the
      // whole editor behind the scrim for seconds on old or imported videos.
      if (['trim', 'stitch', 'revert'].includes(j.kind)) setJob(j);
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

  // The handler closes over fresh state each render; the ref indirection keeps
  // the window listener registered once instead of being torn down and re-added
  // on every frame while the rAF playhead is running.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKeyRef.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
      // The save keystroke everyone presses must save, never drop a split.
      e.preventDefault();
      void save();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      undo();
      return;
    }
    // No other modified key means anything here; without this guard Cmd+S used
    // to fall through to the bare-key branches and split at the playhead.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape' && rangeSel) {
      setRangeSel(null);
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    }
    if (e.key === 's' || e.key === 'S') splitAtPlayhead();
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (rangeSel) cutSelectedRange();
      else if (selected !== null) {
        if (segs[selected]?.kept) removeSegment(selected);
        else restoreSegment(selected);
      }
    }
    // Nudge the playhead for precise cuts; trim handles keep their own arrows.
    if (!target.closest?.('.tl-handle')) {
      if (e.key === 'ArrowLeft') seek(current - (e.shiftKey ? 1 : 0.1));
      if (e.key === 'ArrowRight') seek(current + (e.shiftKey ? 1 : 0.1));
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // --- segment operations ---------------------------------------------------

  /** Apply a new segment layout, remembering the old one for undo. */
  const applySegs = (next: Seg[]) => {
    setHistory((h) => [...h.slice(-49), segs]);
    setSegs(next);
    setSelected(null);
    setRangeSel(null);
  };

  const undo = useCallback(() => {
    setHistory((h) => {
      const prev = h[h.length - 1];
      if (prev) {
        setSegs(prev);
        setSelected(null);
        setRangeSel(null);
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

  /** Remove the drag-painted range in one go (split + split + remove, as one action). */
  const cutSelectedRange = () => {
    if (!rangeSel) return;
    const result = cutRange(segs, rangeSel.start, rangeSel.end);
    if (!result) {
      push('error', 'At least one section must remain.');
      return;
    }
    applySegs(result.segs);
    seek(rangeSel.start);
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

  /** Trim handles: everything before/after t becomes a removed section. */
  const applyTrim = (edge: 'in' | 'out', t: number) => {
    setSegs((prevRaw) => trimEdgeAt(prevRaw, edge, t, duration));
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
    // A trackpad emits 120+ moves/sec and every currentTime write starts a
    // decoder seek, so applying per-move made the drag stutter. Batch to one
    // apply per animation frame with the latest pointer position.
    let pendingX: number | null = null;
    let raf = 0;
    const move = (e: PointerEvent) => {
      pendingX = e.clientX;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (pendingX === null) return;
        const t = timeAtClientX(pendingX);
        applyTrim(edge, t);
        seek(t);
      });
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /**
   * Click to scrub (the section under the pointer becomes the selection); drag
   * to paint a removal range across the bad part. The drag also scrubs as it
   * goes, so the preview shows the frame under the pointer either way.
   */
  const scrubTimeline = (downEvent: React.PointerEvent) => {
    if ((downEvent.target as HTMLElement).closest('.tl-handle')) return;
    const anchorX = downEvent.clientX;
    const anchorT = timeAtClientX(anchorX);
    let dragged = false;
    seek(anchorT);
    const idx = segs.findIndex((s) => anchorT >= s.start && anchorT < s.end);
    setSelected(idx >= 0 ? idx : null);
    const move = (e: PointerEvent) => {
      if (!dragged && Math.abs(e.clientX - anchorX) < DRAG_THRESHOLD_PX) return;
      if (!dragged) {
        dragged = true;
        setSelected(null);
      }
      const t = timeAtClientX(e.clientX);
      seek(t);
      setRangeSel({ start: Math.min(anchorT, t), end: Math.max(anchorT, t) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!dragged) setRangeSel(null);
      else setRangeSel((r) => (r && r.end - r.start >= MIN_RANGE_SEC ? r : null));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // --- actions ----------------------------------------------------------------

  const isEdited = rangesEdited(keptRanges, duration);

  // Let the shell guard sidebar navigation while cuts are unsaved.
  useEffect(() => {
    onDirtyChange?.(isEdited);
  }, [isEdited, onDirtyChange]);
  useEffect(() => {
    return () => onDirtyChange?.(false);
  }, [onDirtyChange]);

  // The shell asked to leave (sidebar click, new-recording navigation).
  useEffect(() => {
    if (!leaveRequested) return;
    if (isEdited) setConfirmLeave('nav');
    else onLeaveResolved?.(true);
    // Deliberately keyed on the request alone: the dirty state at request time decides.
  }, [leaveRequested]);

  // Closing the window with unsaved cuts gets the same modal as any other exit.
  const isEditedRef = useRef(isEdited);
  isEditedRef.current = isEdited;
  const allowUnload = useRef(false);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (!isEditedRef.current || allowUnload.current) return;
      e.preventDefault();
      setConfirmLeave('close');
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  const save = async (): Promise<boolean> => {
    if (!isEdited || busy) return true;
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
      return true;
    } catch (err) {
      const msg = cleanIpcError(err);
      if (/cancelled/i.test(msg)) push('info', 'Cancelled. Your video is exactly as it was.');
      else push('error', msg);
      return false;
    } finally {
      setBusy(false);
      setJob(null);
      setCancelling(false);
    }
  };

  /** Leave via whichever exit triggered the unsaved-cuts modal. */
  const leaveTo = (kind: 'back' | 'nav' | 'close') => {
    if (kind === 'back') onBack();
    else if (kind === 'nav') onLeaveResolved?.(true);
    else {
      allowUnload.current = true;
      window.close();
    }
  };

  const openAddClip = async () => {
    try {
      const all = await window.openloom.listVideos();
      setLibraryVideos(
        all
          .filter((v) => v.id !== id && !v.missing)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      );
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
      const msg = cleanIpcError(err);
      if (/cancelled/i.test(msg)) push('info', 'Cancelled. Your video is exactly as it was.');
      else push('error', msg);
    } finally {
      setBusy(false);
      setJob(null);
      setCancelling(false);
    }
  };

  const revert = async () => {
    setConfirmAction(null);
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
    setConfirmAction(null);
    try {
      await window.openloom.confirmEdits(id);
      await loadMeta();
      setSavedBanner(false);
      push('success', 'Done. The original recording is in the Trash if you ever need it back.');
    } catch (err) {
      push('error', cleanIpcError(err));
    }
  };

  /** Stop the running trim/stitch. Safe: edits land in a temp file until they finish. */
  const cancelRunningJob = () => {
    setCancelling(true);
    void window.openloom.cancelEditJob(id).catch(() => undefined);
  };

  /**
   * "End it here, film the rest": trim off everything after the playhead (the
   * original stays banked), then arm a continuation and open the launcher set
   * up like the first take. The recording that lands next comes straight back
   * to this editor to be joined on. Repeatable for take 3, take 4, and so on.
   */
  const endHereAndFilmRest = async () => {
    if (busy) return;
    videoRef.current?.pause();
    const t = videoRef.current?.currentTime ?? current;
    const cutsTail = t > trimIn + MIN_SEG && t < trimOut - MIN_SEG;
    const next = cutsTail ? trimEdgeAt(segs, 'out', t, duration) : segs;
    const ranges = mergeKept(next);
    setBusy(true);
    try {
      if (rangesEdited(ranges, duration)) {
        await window.openloom.trimVideo(id, ranges.map((r) => ({ start: r.start, end: r.end })));
        await loadMeta();
        setFileVersion((v) => v + 1);
        setCurrent(0);
        setSavedBanner(true);
        await onChanged();
      }
      await window.openloom.beginContinuation(id);
      setArmed(true);
      window.openloom.openLauncher();
      push(
        'info',
        cutsTail
          ? `Ended at ${formatDuration(t)}. Record the rest now - it comes back here to be joined on.`
          : 'Record the rest now - it comes back here to be joined on.'
      );
    } catch (err) {
      const msg = cleanIpcError(err);
      if (/cancelled/i.test(msg)) push('info', 'Cancelled. Your video is exactly as it was.');
      else push('error', msg);
    } finally {
      setBusy(false);
      setJob(null);
      setCancelling(false);
    }
  };

  const cancelArmed = () => {
    void window.openloom.cancelContinuation().catch(() => undefined);
    setArmed(false);
  };

  // Backing out of the editor disarms a waiting continuation, unless a
  // recording is actually underway - then the take must still find its way
  // back. Also runs on the remount after a take is claimed, where the intent
  // is already consumed and the cancel is a harmless no-op.
  const armedRef = useRef(armed);
  armedRef.current = armed;
  useEffect(() => {
    return () => {
      if (!armedRef.current) return;
      void window.openloomInternal.getRecordingState().then(
        (s) => {
          if (s.status === 'idle') void window.openloom.cancelContinuation().catch(() => undefined);
        },
        () => undefined
      );
    };
  }, []);

  const dismissTake = async () => {
    try {
      await window.openloom.dismissContinuation(id);
      setTake(null);
      const m = await window.openloom.getVideo(id);
      setMeta(m);
      push('info', 'Kept as its own recording in your library.');
    } catch (err) {
      push('error', cleanIpcError(err));
    }
  };

  /** Re-upload the edited file so the link people already have shows the new cut. */
  const updateShareLink = async () => {
    if (updatingShare) return;
    setUpdatingShare(true);
    push('info', 'Updating the link in the background. You can keep working.');
    try {
      await window.openloom.shareVideo(id);
      const m = await window.openloom.getVideo(id);
      setMeta(m);
      push('success', 'The link now shows the latest version.');
    } catch (err) {
      push('error', cleanIpcError(err));
    } finally {
      setUpdatingShare(false);
    }
  };

  if (!meta) return <div className="boot" />;

  const hasBankedOriginal = Boolean(meta.edits?.trimmedFrom);
  const editCount = meta.edits?.history?.length ?? 0;
  const editSummary = describeEdits(meta.edits?.history);
  const origDur = meta.edits?.originalDurationSec;
  const origSize = meta.edits?.originalSizeBytes;
  const origLabel = [
    origDur ? formatDuration(origDur) : null,
    origSize ? formatBytes(origSize) : null,
  ]
    .filter(Boolean)
    .join(', ');
  const pct = (t: number) => `${(t / Math.max(duration, 0.01)) * 100}%`;

  return (
    <div className="editor">
      <header className="view-head watch-head">
        <button
          type="button"
          className="icon-btn"
          aria-label="Back to video"
          onClick={() => {
            if (isEdited) setConfirmLeave('back');
            else onBack();
          }}
        >
          <Icon.Back width={17} height={17} />
        </button>
        <h2 className="editor-title">
          Edit <span className="editor-title-name">{meta.title}</span>
          {meta.share && <span className="badge badge-shared">Shared</span>}
        </h2>
        <div className="watch-head-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void endHereAndFilmRest()}
            disabled={busy || armed || Boolean(meta.continuation)}
            title="Trim off everything after the playhead, then record a new take that joins on the end"
          >
            <Icon.Record width={15} height={15} />
            End it here, film the rest
          </button>
          <button type="button" className="btn-secondary" onClick={() => void openAddClip()} disabled={busy}>
            <Icon.Plus width={15} height={15} />
            Add clip
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void save()}
            disabled={!isEdited || busy}
            title={isEdited ? 'Save your cuts (Cmd+S)' : 'Make a cut first - nothing has changed yet'}
          >
            <Icon.Check width={15} height={15} />
            Save edit
          </button>
        </div>
      </header>

      {armed && !meta.continuation && !busy && (
        <div className="edit-banner">
          <Icon.Record width={15} height={15} />
          <span>
            Ready for the rest: record it with the panel on the left of your screen. When you stop, the
            new take lands back here to be joined on.
          </span>
          <button type="button" className="btn-secondary" onClick={cancelArmed}>
            Cancel
          </button>
        </div>
      )}

      {meta.continuation && take && !busy && (
        <div className="edit-banner">
          <Icon.Record width={15} height={15} />
          <span>
            Your new take is ready ({formatDuration(take.durationSec)}). Add it to the end of this
            video?
          </span>
          <button type="button" className="btn-secondary" onClick={() => void dismissTake()}>
            Keep it separate
          </button>
          <button type="button" className="btn-primary" onClick={() => void addClip(take.id)}>
            Add it to the end
          </button>
        </div>
      )}

      {(savedBanner || hasBankedOriginal) && !busy && (
        <div className="edit-banner">
          <Icon.Clock width={15} height={15} />
          <span>
            {editCount > 0
              ? `${editCount === 1 ? '1 change' : `${editCount} changes`} so far (${editSummary}). Your original recording${origLabel ? ` (${origLabel})` : ''} is kept safe until you decide.`
              : 'Your original recording is kept safe until you decide.'}
          </span>
          <button type="button" className="btn-secondary" onClick={() => setConfirmAction('revert')}>
            <Icon.Undo width={14} height={14} />
            Go back to the original
          </button>
          <button type="button" className="btn-primary" onClick={() => setConfirmAction('keep')}>
            Keep these changes
          </button>
        </div>
      )}

      {meta.share && (savedBanner || hasBankedOriginal) && !busy && (
        <div className="edit-banner">
          <Icon.Link width={15} height={15} />
          <span>
            This video is shared. Anyone with the link still sees the version from before your changes.
          </span>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void updateShareLink()}
            disabled={updatingShare}
          >
            {updatingShare ? 'Updating…' : 'Update the link'}
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
        <span className="editor-result-len" title="Length before and after this edit">
          {isEdited
            ? `${formatDuration(duration)} becomes ${formatDuration(totalKept(segs))}`
            : `Length ${formatDuration(duration)}`}
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
        {rangeSel ? (
          <button
            type="button"
            className="btn-danger-quiet"
            onClick={cutSelectedRange}
            title="Remove the highlighted part (Delete)"
          >
            <Icon.Scissors width={15} height={15} />
            Cut this out ({formatDuration(rangeSel.end - rangeSel.start)})
          </button>
        ) : selected !== null && segs[selected] && !segs[selected]!.kept ? (
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
            title={
              selected === null || !segs[selected]?.kept
                ? 'Drag across the part you want gone, or click a section first'
                : 'Remove the selected section (Delete)'
            }
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

        {/* drag-painted removal range. Solid fill + edge borders, deliberately
            in the danger colour: this is the part that goes. */}
        {rangeSel && (
          <div
            className="tl-rangesel"
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: pct(rangeSel.start),
              width: pct(rangeSel.end - rangeSel.start),
              background: 'rgba(255, 69, 58, 0.18)',
              borderLeft: '2px solid var(--ol-danger)',
              borderRight: '2px solid var(--ol-danger)',
              pointerEvents: 'none',
            }}
          />
        )}

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

        {/* Full-width layer translated by % of its own width: the per-frame move
            stays on the compositor instead of re-laying-out the whole timeline. */}
        <div
          className="tl-playhead"
          style={{ transform: `translateX(${(current / Math.max(duration, 0.01)) * 100}%)` }}
          aria-hidden="true"
        />
      </div>

      <p className="editor-hint">
        Drag across a part you do not want, then press Cut this out. Click to move the playhead; drag
        the handles to trim the ends. Nothing touches the file until you save (Cmd+S), and Cmd+Z undoes
        any step.
      </p>

      {(busy || job) && (
        <div className="job-overlay" role="status" aria-live="polite">
          <div className="job-card">
            <span className="spinner" aria-hidden="true" />
            <div className="job-text">
              <strong>{cancelling ? 'Stopping…' : (job?.note ?? 'Working on the edit')}</strong>
              <div className="job-bar">
                <div className="job-bar-fill" style={{ transform: `scaleX(${(job?.pct ?? 5) / 100})` }} />
              </div>
            </div>
            {job && ['trim', 'stitch'].includes(job.kind) && (
              <button
                type="button"
                className="btn-secondary"
                onClick={cancelRunningJob}
                disabled={cancelling}
                title="Stop this edit. Your video stays exactly as it was."
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {confirmLeave && (
        <Modal title="You have cuts you have not saved" onClose={() => {
          if (confirmLeave === 'nav') onLeaveResolved?.(false);
          setConfirmLeave(null);
        }}>
          <div className="modal-form">
            <p className="modal-text">
              The cuts you marked on the timeline are not saved yet. Leave now and they are gone.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  if (confirmLeave === 'nav') onLeaveResolved?.(false);
                  setConfirmLeave(null);
                }}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="btn-danger-quiet"
                onClick={() => {
                  const kind = confirmLeave;
                  setConfirmLeave(null);
                  leaveTo(kind);
                }}
              >
                Leave without saving
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  const kind = confirmLeave;
                  setConfirmLeave(null);
                  void save().then((ok) => {
                    if (ok) leaveTo(kind);
                  });
                }}
              >
                Save, then leave
              </button>
            </div>
          </div>
        </Modal>
      )}

      {confirmAction === 'keep' && (
        <Modal title="Keep these changes" onClose={() => setConfirmAction(null)}>
          <div className="modal-form">
            <p className="modal-text">
              Your edited video stays exactly as it is. The original recording
              {origLabel ? ` (${origLabel})` : ''} moves to the Trash, so you can still get it back
              from there if you ever need it.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setConfirmAction(null)}>
                Not yet
              </button>
              <button type="button" className="btn-primary" onClick={() => void keepEdit()}>
                Keep changes, Trash the original
              </button>
            </div>
          </div>
        </Modal>
      )}

      {confirmAction === 'revert' && (
        <Modal title="Go back to the original" onClose={() => setConfirmAction(null)}>
          <div className="modal-form">
            <p className="modal-text">
              This undoes {editCount > 0 ? `all your changes (${editSummary})` : 'your changes'} and
              brings back the original recording{origDur ? ` (${formatDuration(origDur)})` : ''}. The
              edited version will be gone.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setConfirmAction(null)}>
                Keep my changes
              </button>
              <button type="button" className="btn-danger" onClick={() => void revert()}>
                Bring back the original
              </button>
            </div>
          </div>
        </Modal>
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
                      {Date.now() - new Date(v.createdAt).getTime() < 10 * 60_000 && (
                        <>
                          {' '}
                          <span className="badge badge-shared">Just recorded</span>
                        </>
                      )}
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
