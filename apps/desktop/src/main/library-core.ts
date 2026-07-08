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

  videoDir(id: string): string {
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
    fs.mkdirSync(this.videoDir(meta.id), { recursive: true });
    fs.writeFileSync(this.metaPath(meta.id), JSON.stringify(meta, null, 2));
  }

  // -- index (folders) ------------------------------------------------------

  private indexPath(): string {
    return path.join(this.dir, 'library.json');
  }

  readIndex(): LibraryIndex {
    try {
      const raw = fs.readFileSync(this.indexPath(), 'utf8');
      const idx = JSON.parse(raw) as LibraryIndex;
      return { folders: idx.folders ?? [], order: idx.order ?? [] };
    } catch {
      return { folders: [], order: [] };
    }
  }

  private writeIndex(idx: LibraryIndex): void {
    this.ensureRoot();
    fs.writeFileSync(this.indexPath(), JSON.stringify(idx, null, 2));
  }

  // -- videos ---------------------------------------------------------------

  list(): VideoMeta[] {
    this.ensureRoot();
    const out: VideoMeta[] = [];
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      const meta = this.readMeta(entry.name);
      if (meta) {
        out.push(meta);
      } else if (fs.existsSync(this.metaPath(entry.name))) {
        this.deps.warn?.(`skipping corrupt meta.json in ${entry.name}`);
      }
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out;
  }

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
    const idx = this.readIndex();
    idx.order = idx.order.filter((v) => v !== id);
    this.writeIndex(idx);
  }

  async duplicate(id: string): Promise<VideoMeta> {
    const source = this.get(id);
    const newId = this.deps.newId();
    const from = this.videoDir(id);
    const to = this.videoDir(newId);
    // Async copy: a large recording can be hundreds of MB to GB; a synchronous
    // fs.cpSync here blocks the Electron main-process event loop and freezes
    // every window for the whole copy.
    await fs.promises.cp(from, to, { recursive: true });
    const copy: VideoMeta = {
      ...source,
      id: newId,
      title: `${source.title} copy`,
      createdAt: new Date().toISOString(),
    };
    delete copy.share;
    this.writeMeta(copy);
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

  /**
   * Title search now; transcript.json (segments) is searched when present so
   * transcript search lights up as soon as the transcription module lands.
   */
  search(q: string): SearchMatch[] {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const results: SearchMatch[] = [];
    for (const meta of this.list()) {
      const matches: string[] = [];
      if (meta.title.toLowerCase().includes(needle)) matches.push(meta.title);
      if ((meta.ai?.title ?? '').toLowerCase().includes(needle)) matches.push(meta.ai!.title!);
      const transcriptPath = path.join(this.videoDir(meta.id), 'transcript.json');
      if (fs.existsSync(transcriptPath)) {
        try {
          const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8')) as {
            segments?: { text?: string }[];
          };
          for (const seg of transcript.segments ?? []) {
            const text = seg.text ?? '';
            if (text.toLowerCase().includes(needle)) {
              matches.push(text.trim());
              if (matches.length >= 6) break;
            }
          }
        } catch {
          this.deps.warn?.(`unreadable transcript.json for ${meta.id}`);
        }
      }
      if (matches.length > 0) results.push({ id: meta.id, matches });
    }
    return results;
  }
}
