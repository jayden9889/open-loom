/**
 * Library store core: scan/CRUD/folders/search over the save folder.
 * Pure Node (trash is injected) so it is unit-testable. Layout:
 *   <saveDir>/<videoId>/meta.json + video.mp4 + thumb.jpg + preview.gif + ...
 *   <saveDir>/library.json  (folders + ordering cache)
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Folder, LibraryIndex, SearchMatch, VideoMeta } from '@shared/types';

export interface LibraryDeps {
  /** Move a directory to the OS trash (shell.trashItem in the app, fs.rm in tests). */
  trash(absPath: string): Promise<void>;
  newId(): string;
  warn?(msg: string): void;
  /** Surface a user-visible recovery message (a toast in the app, silent in tests). */
  notify?(msg: string): void;
}

/**
 * Atomic write: write to a temp file in the same directory, fsync, then rename
 * over the target. Rename within a filesystem is atomic, so a crash or power
 * cut mid-write can no longer truncate the live file - a bare writeFileSync
 * here could silently erase a recording's meta.json or every folder in
 * library.json.
 */
export function writeFileAtomic(target: string, data: string): void {
  const tmp = `${target}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;

/**
 * Path-traversal-safe resolution of a file inside a video's library dir.
 * Returns null for anything that would escape <libDir>/<videoId>/.
 */
export function resolveLibraryPath(libDir: string, videoId: string, file: string): string | null {
  if (!ID_RE.test(videoId)) return null;
  if (!FILE_RE.test(file) || file.includes('..')) return null;
  const base = path.resolve(libDir);
  const resolved = path.resolve(base, videoId, file);
  if (!resolved.startsWith(base + path.sep)) return null;
  const videoDir = path.resolve(base, videoId);
  if (path.dirname(resolved) !== videoDir) return null;
  // Defeat symlinks: a hostile recording folder could ship video.mp4/thumb.jpg as
  // a symlink to an arbitrary file (e.g. ~/.ssh/id_rsa) that would then be served
  // to the player or uploaded to the user's share host. If the file exists, its
  // real path must still resolve inside the video dir. A not-yet-created write
  // target is allowed - the lexical containment checks above already cover it.
  try {
    if (fs.existsSync(resolved) && path.dirname(fs.realpathSync(resolved)) !== fs.realpathSync(videoDir)) {
      return null;
    }
  } catch {
    return null;
  }
  return resolved;
}

export class LibraryStore {
  constructor(
    private readonly dir: string,
    private readonly deps: LibraryDeps
  ) {}

  get root(): string {
    return this.dir;
  }

  private ensureRoot(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Every filesystem path in the store is derived from this method, so the id
   * is validated here rather than at each call site - get/delete/duplicate all
   * took the id straight from IPC and only resolveLibraryPath checked it.
   */
  videoDir(id: string): string {
    if (!ID_RE.test(id)) throw new Error('Unknown recording.');
    return path.join(this.dir, id);
  }

  private metaPath(id: string): string {
    return path.join(this.videoDir(id), 'meta.json');
  }

  private readMeta(id: string): VideoMeta | null {
    try {
      const raw = fs.readFileSync(this.metaPath(id), 'utf8');
      const meta = JSON.parse(raw) as VideoMeta;
      if (!meta.id || meta.id !== id) return null;
      return meta;
    } catch {
      return null;
    }
  }

  private writeMeta(meta: VideoMeta): void {
    // `missing` is computed at list() time from the disk state; persisting it
    // would fossilise a stale answer in meta.json.
    const persisted = { ...meta };
    delete persisted.missing;
    fs.mkdirSync(this.videoDir(meta.id), { recursive: true });
    writeFileAtomic(this.metaPath(meta.id), JSON.stringify(persisted, null, 2));
  }

  // -- index (folders) ------------------------------------------------------

  private indexPath(): string {
    return path.join(this.dir, 'library.json');
  }

  readIndex(): LibraryIndex {
    let raw: string;
    try {
      raw = fs.readFileSync(this.indexPath(), 'utf8');
    } catch {
      // Missing is the normal first-run state.
      return { folders: [], order: [] };
    }
    try {
      const idx = JSON.parse(raw) as LibraryIndex;
      return { folders: idx.folders ?? [], order: idx.order ?? [] };
    } catch {
      // Corrupt is NOT the same as missing: presenting it as "no folders" and
      // letting the next writeIndex overwrite the file would make the loss
      // permanent and silent. Move it aside so it can be recovered, and say so.
      const backup = path.join(this.dir, `library.corrupt-${Date.now()}.json`);
      try {
        fs.renameSync(this.indexPath(), backup);
      } catch {
        /* the read still returns empty below */
      }
      this.deps.warn?.(`library.json was unreadable; moved it to ${path.basename(backup)}`);
      this.deps.notify?.(
        'The folder list could not be read, so folders have been reset. The unreadable file was kept in the save folder as a backup.'
      );
      return { folders: [], order: [] };
    }
  }

  private writeIndex(idx: LibraryIndex): void {
    this.ensureRoot();
    writeFileAtomic(this.indexPath(), JSON.stringify(idx, null, 2));
  }

  // -- videos ---------------------------------------------------------------

  list(): VideoMeta[] {
    this.ensureRoot();
    const out: VideoMeta[] = [];
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      const meta = this.readMeta(entry.name);
      if (meta) {
        // A recording deleted or moved outside the app used to stay in the
        // grid as a healthy-looking dead card; flag it so the UI can be honest.
        if (!fs.existsSync(path.join(this.dir, entry.name, 'video.mp4'))) meta.missing = true;
        out.push(meta);
      } else if (fs.existsSync(this.metaPath(entry.name))) {
        this.deps.warn?.(`skipping corrupt meta.json in ${entry.name}`);
        if (!this.corruptNotified.has(entry.name)) {
          this.corruptNotified.add(entry.name);
          this.deps.notify?.(
            `A recording in the save folder could not be read (${entry.name}). Its files are still there; the entry is hidden until its meta.json is repaired.`
          );
        }
      }
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out;
  }

  /** Corrupt meta.json dirs already toasted this session, so list() does not re-toast per refresh. */
  private readonly corruptNotified = new Set<string>();

  get(id: string): VideoMeta {
    const meta = this.readMeta(id);
    if (!meta) throw new Error(`Video ${id} was not found in the library.`);
    return meta;
  }

  /** Create a library entry from an already-populated directory's meta. */
  put(meta: VideoMeta): VideoMeta {
    this.writeMeta(meta);
    return meta;
  }

  update(id: string, patch: Partial<VideoMeta>): VideoMeta {
    const current = this.get(id);
    const next: VideoMeta = { ...current, ...patch, id };
    if (patch.share === undefined && 'share' in patch) delete next.share;
    this.writeMeta(next);
    return next;
  }

  async delete(id: string): Promise<void> {
    this.get(id);
    await this.deps.trash(this.videoDir(id));
    this.transcriptCache.delete(id);
    const idx = this.readIndex();
    idx.order = idx.order.filter((v) => v !== id);
    this.writeIndex(idx);
  }

  async duplicate(id: string): Promise<VideoMeta> {
    const source = this.get(id);
    const newId = this.deps.newId();
    const from = this.videoDir(id);
    const to = this.videoDir(newId);
    const copy: VideoMeta = {
      ...source,
      id: newId,
      title: `${source.title} copy`,
      createdAt: new Date().toISOString(),
    };
    // Per-publication state must not carry over: the copy is not shared and not
    // on YouTube. Keeping youtubeUrl made "Copy YouTube link" on the duplicate
    // hand out a link to a different video.
    delete copy.share;
    delete copy.youtubeUrl;
    delete copy.youtubePrivacy;
    // Stage into a dot-prefixed temp dir, invisible to list() (which only
    // accepts ID_RE names), and rename into place only once the copy and its
    // corrected meta.json are complete. A failure part-way (disk full,
    // permissions) used to leave a partial multi-GB directory on disk forever,
    // holding the SOURCE's meta.json and invisible to every screen in the app.
    const staging = path.join(this.dir, `.tmp-${newId}`);
    try {
      // Async copy: a large recording can be hundreds of MB to GB; a synchronous
      // fs.cpSync here blocks the Electron main-process event loop and freezes
      // every window for the whole copy.
      await fs.promises.cp(from, staging, { recursive: true });
      writeFileAtomic(path.join(staging, 'meta.json'), JSON.stringify(copy, null, 2));
      fs.renameSync(staging, to);
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw err;
    }
    return copy;
  }

  moveVideo(id: string, folderId: string | null): VideoMeta {
    if (folderId !== null && !this.readIndex().folders.some((f) => f.id === folderId)) {
      throw new Error('That folder no longer exists.');
    }
    return this.update(id, { folderId });
  }

  // -- folders ---------------------------------------------------------------

  listFolders(): Folder[] {
    return this.readIndex().folders;
  }

  createFolder(name: string): Folder {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Folder name cannot be empty.');
    const idx = this.readIndex();
    const folder: Folder = { id: this.deps.newId(), name: trimmed };
    idx.folders.push(folder);
    this.writeIndex(idx);
    return folder;
  }

  renameFolder(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Folder name cannot be empty.');
    const idx = this.readIndex();
    const folder = idx.folders.find((f) => f.id === id);
    if (!folder) throw new Error('That folder no longer exists.');
    folder.name = trimmed;
    this.writeIndex(idx);
  }

  /** Deleting a folder moves its videos back to the Library (SPEC L2). */
  deleteFolder(id: string): void {
    const idx = this.readIndex();
    idx.folders = idx.folders.filter((f) => f.id !== id);
    this.writeIndex(idx);
    for (const meta of this.list()) {
      if (meta.folderId === id) this.update(meta.id, { folderId: null });
    }
  }

  // -- search ----------------------------------------------------------------

  /** In-memory transcript index, invalidated per video by mtime + size. */
  private readonly transcriptCache = new Map<string, { stamp: string; texts: string[] }>();

  /**
   * Transcript segment texts for one video, served from RAM once read. The old
   * per-query readFileSync of every transcript was a synchronous full-library
   * disk scan on the main-process event loop, per keystroke - at 100+
   * recordings it stuttered the whole app, including a recording in flight.
   */
  private async transcriptTexts(id: string): Promise<string[]> {
    const transcriptPath = path.join(this.videoDir(id), 'transcript.json');
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(transcriptPath);
    } catch {
      this.transcriptCache.delete(id);
      return [];
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const hit = this.transcriptCache.get(id);
    if (hit && hit.stamp === stamp) return hit.texts;
    try {
      const transcript = JSON.parse(await fs.promises.readFile(transcriptPath, 'utf8')) as {
        segments?: { text?: string }[];
      };
      const texts = (transcript.segments ?? []).map((seg) => (seg.text ?? '').trim()).filter(Boolean);
      this.transcriptCache.set(id, { stamp, texts });
      return texts;
    } catch {
      this.deps.warn?.(`unreadable transcript.json for ${id}`);
      this.transcriptCache.delete(id);
      return [];
    }
  }

  /**
   * Searches titles, descriptions, AI titles/summaries, chapter titles and
   * transcript segments. Async so the transcript reads yield to the event loop.
   */
  async search(q: string): Promise<SearchMatch[]> {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const results: SearchMatch[] = [];
    for (const meta of this.list()) {
      const matches: string[] = [];
      const consider = (text: string | undefined) => {
        if (text && text.toLowerCase().includes(needle)) matches.push(text);
      };
      consider(meta.title);
      consider(meta.ai?.title);
      consider(meta.description);
      consider(meta.ai?.summary);
      for (const chapter of meta.ai?.chapters ?? []) consider(chapter.title);
      for (const text of await this.transcriptTexts(meta.id)) {
        if (matches.length >= 6) break;
        if (text.toLowerCase().includes(needle)) matches.push(text);
      }
      if (matches.length > 0) results.push({ id: meta.id, matches });
    }
    return results;
  }
}
