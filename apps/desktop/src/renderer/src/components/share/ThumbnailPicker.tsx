/**
 * Thumbnail picker: the client's first impression of the video is currently a
 * coin-flip auto-grabbed frame. Scrub to a frame and use it, or pick an image
 * file. Writes through setCustomThumbnail (main), which re-encodes anything
 * that is not provably a JPEG and pushes the result to an existing share.
 */
import { useEffect, useRef, useState } from 'react';
import { Modal, cleanIpcError, formatDuration } from '../ui';

export function ThumbnailPicker({
  videoId,
  videoUrl,
  durationSec,
  currentTimeSec,
  onClose,
  onChanged,
}: {
  videoId: string;
  videoUrl: string;
  durationSec: number;
  /** Where the Watch player is parked; the natural first candidate frame. */
  currentTimeSec: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [atSec, setAtSec] = useState(() =>
    Math.min(Math.max(0, currentTimeSec), Math.max(0, durationSec))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the preview parked on the picked frame.
  useEffect(() => {
    const v = videoRef.current;
    if (v && Math.abs(v.currentTime - atSec) > 0.05) v.currentTime = atSec;
  }, [atSec]);

  const useFrame = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.openloom.setCustomThumbnail(videoId, { atSec });
      onChanged();
    } catch (err) {
      setError(cleanIpcError(err));
      setBusy(false);
    }
  };

  const useImage = async () => {
    setError(null);
    const path = await window.openloom.pickFile('image');
    if (!path) return;
    setBusy(true);
    try {
      await window.openloom.setCustomThumbnail(videoId, { path });
      onChanged();
    } catch (err) {
      setError(cleanIpcError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Pick a thumbnail" onClose={onClose} width={480}>
      <div className="thumb-picker">
        <video
          ref={videoRef}
          className="thumb-picker-video"
          src={videoUrl}
          muted
          playsInline
          preload="auto"
          aria-label="Frame preview"
        />
        <div className="thumb-picker-scrub">
          <input
            type="range"
            min={0}
            max={Math.max(0.1, durationSec)}
            step={0.1}
            value={atSec}
            aria-label="Pick a frame"
            onChange={(e) => setAtSec(Number(e.target.value))}
          />
          <span className="thumb-picker-time">{formatDuration(atSec)}</span>
        </div>
        {error && <p className="thumb-picker-error">{error}</p>}
        <div className="thumb-picker-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void useImage()}>
            Choose an image
          </button>
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void useFrame()}>
            {busy ? 'Saving' : 'Use this frame'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
