/**
 * Capture source enumeration + the getDisplayMedia request handler.
 * The recorder engine window calls getDisplayMedia; this handler injects the
 * desktopCapturer source picked in the UI and, when asked and supported,
 * system-audio loopback (native in Electron >= 39 via Core Audio taps on
 * macOS 14.2+ / WASAPI on Windows).
 */
import { desktopCapturer, session } from 'electron';
import type { CaptureSource } from '@shared/types';
import { systemAudioSupported } from './permissions';
import { log } from './logger';

interface PendingCapture {
  sourceId: string;
  systemAudio: boolean;
}

let pending: PendingCapture | null = null;

export function setPendingCapture(sourceId: string, systemAudio: boolean): void {
  pending = { sourceId, systemAudio };
}

export function clearPendingCapture(): void {
  pending = null;
}

export function installDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      const wanted = pending;
      if (!wanted) {
        log.warn('getDisplayMedia requested with no pending capture; denying');
        callback({});
        return;
      }
      desktopCapturer
        .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const source = sources.find((s) => s.id === wanted.sourceId);
          if (!source) {
            log.error(`capture source ${wanted.sourceId} disappeared; denying request`);
            callback({});
            return;
          }
          const audio = wanted.systemAudio && systemAudioSupported() ? ('loopback' as const) : undefined;
          callback(audio ? { video: source, audio } : { video: source });
        })
        .catch((err) => {
          log.error(`desktopCapturer.getSources failed: ${String(err)}`);
          callback({});
        });
    },
    { useSystemPicker: false }
  );
}

/** Names of our own overlay windows, filtered out of the window picker. */
const OWN_WINDOW_TITLES = new Set(['Open Loom', 'openloom-hud', 'openloom-bubble', 'openloom-countdown', 'openloom-draw', 'openloom-engine']);

export async function listCaptureSources(): Promise<CaptureSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 328, height: 205 },
    fetchWindowIcons: false,
  });
  const screens = sources.filter((s) => s.id.startsWith('screen:'));
  const result: CaptureSource[] = [];
  for (const s of sources) {
    const isDisplay = s.id.startsWith('screen:');
    if (!isDisplay && OWN_WINDOW_TITLES.has(s.name)) continue;
    if (!isDisplay && !s.name.trim()) continue;
    result.push({
      id: s.id,
      name: isDisplay && screens.length === 1 ? 'Entire screen' : s.name,
      thumbnailDataUrl: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
      display: isDisplay,
    });
  }
  // Displays first, then windows alphabetically.
  result.sort((a, b) => {
    if (a.display !== b.display) return a.display ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return result;
}

/** display_id for a screen source (used to place overlays on the right display). */
export async function displayIdForSource(sourceId: string): Promise<string | undefined> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });
    return sources.find((s) => s.id === sourceId)?.display_id;
  } catch {
    return undefined;
  }
}
