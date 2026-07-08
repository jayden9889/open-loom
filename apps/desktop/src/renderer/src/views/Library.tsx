/**
 * Library grid (SPEC L1-L3): thumbnail cards with GIF hover preview,
 * duration badge, search across titles + transcripts, folder filtering,
 * card context menu, designed empty states.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Folder, VideoMeta } from '@shared/types';
import { Icon } from '../components/icons';
import {
  ContextMenu,
  Modal,
  cleanIpcError,
  formatDate,
  formatDuration,
  useToasts,
  type MenuItem,
} from '../components/ui';
import { ShareDialog } from '../components/share/ShareDialog';

/** Live upload state for a library card badge (SPEC R14). */
interface CardUpload {
  pct: number;
  failed: boolean;
}

function VideoCard({
  video,
  upload,
  onOpen,
  onMenu,
  onRetryUpload,
}: {
  video: VideoMeta;
  upload?: CardUpload;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  onRetryUpload: () => void;
}) {
  const [hover, setHover] = useState(false);
  const thumb = window.openloom.fileUrl(video.id, 'thumb.jpg');
  const gif = window.openloom.fileUrl(video.id, 'preview.gif');
  const uploading = upload !== undefined && !upload.failed;
  // A share block with no uploadedAt is a link that was minted (and possibly
  // copied) but whose upload never landed: it is a dead 404 until retried. This
  // persists across navigation and restart, unlike the in-memory `upload` state.
  const notLive = !!video.share && !video.share.uploadedAt;
  const showRetry = (upload?.failed ?? false) || (notLive && !uploading);

  return (
    <div
      className="video-card"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <button type="button" className="video-thumb" onClick={onOpen} aria-label={`Watch ${video.title}`}>
        <img src={hover ? gif : thumb} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} />
        <span className="video-duration">{formatDuration(video.durationSec)}</span>
        {uploading && (
          <span className="video-upload" aria-label={`Uploading ${upload!.pct}%`}>
            <span className="spinner" aria-hidden="true" />
            Uploading {upload!.pct}%
          </span>
        )}
        {!hover && !uploading && (
          <span className="video-play" aria-hidden="true">
            <Icon.Play width={18} height={18} />
          </span>
        )}
      </button>
      <div className="video-card-meta">
        <button type="button" className="video-title" onClick={onOpen} title={video.title}>
          {video.title}
        </button>
        <div className="video-sub">
          <span>{formatDate(video.createdAt)}</span>
          {showRetry ? (
            <button
              type="button"
              className="badge badge-failed"
              title="This share link is not live yet - the upload did not finish. Click to retry."
              onClick={onRetryUpload}
            >
              <Icon.Refresh width={12} height={12} />
              Retry upload
            </button>
          ) : uploading ? (
            <span className="badge badge-uploading">Uploading</span>
          ) : (
            <span className={`badge${video.share ? ' badge-shared' : ''}`}>{video.share ? 'Shared' : 'Local'}</span>
          )}
          <button
            type="button"
            className="icon-btn video-more"
            aria-label="More actions"
            onClick={(e) => {
              const rect = (e.target as HTMLElement).getBoundingClientRect();
              onMenu(rect.left, rect.bottom + 4);
            }}
          >
            <Icon.More width={15} height={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function LibraryView({
  videos,
  folders,
  folderId,
  onOpen,
  onChanged,
  onRecord,
  onOpenSharingSettings,
}: {
  videos: VideoMeta[];
  folders: Folder[];
  folderId: string | null;
  onOpen: (id: string) => void;
  onChanged: () => Promise<void>;
  onRecord: () => void;
  onOpenSharingSettings: () => void;
}) {
  const { push } = useToasts();
  const [query, setQuery] = useState('');
  const [searchIds, setSearchIds] = useState<Set<string> | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; video: VideoMeta } | null>(null);
  const [renaming, setRenaming] = useState<VideoMeta | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<VideoMeta | null>(null);
  const [folderRename, setFolderRename] = useState<Folder | null>(null);
  const [folderRenameValue, setFolderRenameValue] = useState('');
  const [sharing, setSharing] = useState<VideoMeta | null>(null);
  const [uploads, setUploads] = useState<Record<string, CardUpload>>({});

  const folder = folders.find((f) => f.id === folderId) ?? null;

  // Track background upload progress for the per-card badge (SPEC R14).
  useEffect(() => {
    return window.openloom.onJobProgress((j) => {
      if (j.kind !== 'upload') return;
      const failed = j.note?.startsWith('Upload failed') ?? false;
      if (j.pct >= 100 && !failed) {
        setUploads((u) => {
          const { [j.videoId]: _done, ...rest } = u;
          return rest;
        });
        void onChanged();
      } else {
        setUploads((u) => ({ ...u, [j.videoId]: { pct: j.pct, failed } }));
      }
    });
  }, [onChanged]);

  const retryUpload = (video: VideoMeta) => {
    setUploads((u) => ({ ...u, [video.id]: { pct: 0, failed: false } }));
    void window.openloom.shareVideo(video.id).catch((err) => {
      push('error', cleanIpcError(err));
      setUploads((u) => ({ ...u, [video.id]: { pct: 100, failed: true } }));
    });
  };

  // Search titles locally for instant feedback + transcripts via main.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchIds(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void window.openloom
        .searchVideos(q)
        .then((matches) => {
          if (!cancelled) setSearchIds(new Set(matches.map((m) => m.id)));
        })
        .catch(() => setSearchIds(new Set()));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const shown = useMemo(() => {
    let list = videos;
    if (folderId !== null) list = list.filter((v) => v.folderId === folderId);
    if (searchIds !== null) list = list.filter((v) => searchIds.has(v.id));
    return list;
  }, [videos, folderId, searchIds]);

  const menuItems = (video: VideoMeta): MenuItem[] => [
    ...(video.share
      ? [
          {
            label: 'Copy link',
            icon: <Icon.Link width={15} height={15} />,
            onClick: () => {
              window.openloom.copyToClipboard(video.share!.url);
              push('success', 'Link copied.');
            },
          },
        ]
      : []),
    {
      label: video.share ? 'Share settings…' : 'Share…',
      icon: <Icon.Link width={15} height={15} />,
      onClick: () => setSharing(video),
    },
    {
      label: 'Rename',
      icon: <Icon.Pencil width={15} height={15} />,
      onClick: () => {
        setRenaming(video);
        setRenameValue(video.title);
      },
    },
    {
      label: 'Move to folder',
      icon: <Icon.Folder width={15} height={15} />,
      submenu: [
        {
          label: 'Library (no folder)',
          disabled: video.folderId == null,
          onClick: () => {
            void window.openloom
              .moveVideo(video.id, null)
              .then(onChanged)
              .catch((err) => push('error', cleanIpcError(err)));
          },
        },
        ...folders.map((f) => ({
          label: f.name,
          disabled: video.folderId === f.id,
          onClick: () => {
            void window.openloom
              .moveVideo(video.id, f.id)
              .then(onChanged)
              .catch((err) => push('error', cleanIpcError(err)));
          },
        })),
      ],
    },
    {
      label: navigator.platform.toLowerCase().includes('mac') ? 'Reveal in Finder' : 'Show in folder',
      icon: <Icon.Reveal width={15} height={15} />,
      onClick: () => window.openloom.revealVideo(video.id),
    },
    {
      label: 'Duplicate',
      icon: <Icon.Duplicate width={15} height={15} />,
      separatorAfter: true,
      onClick: () => {
        void window.openloom
          .duplicateVideo(video.id)
          .then(onChanged)
          .then(() => push('success', 'Video duplicated.'))
          .catch((err) => push('error', cleanIpcError(err)));
      },
    },
    {
      label: 'Delete',
      icon: <Icon.Trash width={15} height={15} />,
      danger: true,
      onClick: () => setConfirmDelete(video),
    },
  ];

  return (
    <div className="library">
      <header className="view-head">
        <div className="view-head-title">
          <h2>{folder ? folder.name : 'Library'}</h2>
          {folder && (
            <div className="folder-actions">
              <button
                type="button"
                className="icon-btn"
                aria-label="Rename folder"
                title="Rename folder"
                onClick={() => {
                  setFolderRename(folder);
                  setFolderRenameValue(folder.name);
                }}
              >
                <Icon.Pencil width={15} height={15} />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="Delete folder"
                title="Delete folder (videos move to Library)"
                onClick={() => {
                  void window.openloom
                    .deleteFolder(folder.id)
                    .then(onChanged)
                    .then(() => push('success', 'Folder deleted. Its videos are back in the Library.'))
                    .catch((err) => push('error', cleanIpcError(err)));
                }}
              >
                <Icon.Trash width={15} height={15} />
              </button>
            </div>
          )}
        </div>
        <div className="searchbox">
          <Icon.Search width={15} height={15} />
          <input
            type="search"
            placeholder="Search titles and transcripts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search videos"
          />
        </div>
      </header>

      {shown.length === 0 ? (
        query ? (
          <div className="empty-state">
            <Icon.Search width={40} height={40} />
            <h3>No matches for “{query}”</h3>
            <p>Search covers titles now and transcripts once a video has been transcribed.</p>
          </div>
        ) : (
          <div className="empty-state">
            <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
              <rect x="2.5" y="4.5" width="19" height="13" rx="2.5" />
              <circle cx="7.5" cy="13.5" r="2.4" fill="currentColor" stroke="none" opacity="0.5" />
              <path d="M9 21h6" />
              <circle cx="14.5" cy="10" r="3.2" stroke="currentColor" />
              <circle cx="14.5" cy="10" r="1.1" fill="currentColor" stroke="none" />
            </svg>
            <h3>{folder ? 'This folder is empty' : 'Record your first video'}</h3>
            <p>
              {folder
                ? 'Move recordings here from the Library, or record something new.'
                : 'Capture your screen, camera or both. Recordings stay on this machine until you share them.'}
            </p>
            <button type="button" className="btn-primary" onClick={onRecord}>
              <Icon.Record width={15} height={15} />
              New recording
            </button>
          </div>
        )
      ) : (
        <div className="video-grid">
          {shown.map((v) => (
            <VideoCard
              key={v.id}
              video={v}
              upload={uploads[v.id]}
              onOpen={() => onOpen(v.id)}
              onMenu={(x, y) => setMenu({ x, y, video: v })}
              onRetryUpload={() => retryUpload(v)}
            />
          ))}
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.video)} onClose={() => setMenu(null)} />}

      {sharing && (
        <ShareDialog
          video={sharing}
          onClose={() => setSharing(null)}
          onChange={() => void onChanged()}
          onOpenSharingSettings={() => {
            setSharing(null);
            onOpenSharingSettings();
          }}
        />
      )}

      {renaming && (
        <Modal title="Rename video" onClose={() => setRenaming(null)}>
          <form
            className="modal-form"
            onSubmit={(e) => {
              e.preventDefault();
              const title = renameValue.trim();
              if (!title) return;
              void window.openloom
                .updateVideo(renaming.id, { title })
                .then(onChanged)
                .catch((err) => push('error', cleanIpcError(err)));
              setRenaming(null);
            }}
          >
            <input autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)} aria-label="Video title" />
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setRenaming(null)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={!renameValue.trim()}>
                Rename
              </button>
            </div>
          </form>
        </Modal>
      )}

      {folderRename && (
        <Modal title="Rename folder" onClose={() => setFolderRename(null)}>
          <form
            className="modal-form"
            onSubmit={(e) => {
              e.preventDefault();
              const name = folderRenameValue.trim();
              if (!name) return;
              void window.openloom
                .renameFolder(folderRename.id, name)
                .then(onChanged)
                .catch((err) => push('error', cleanIpcError(err)));
              setFolderRename(null);
            }}
          >
            <input autoFocus value={folderRenameValue} onChange={(e) => setFolderRenameValue(e.target.value)} aria-label="Folder name" />
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setFolderRename(null)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={!folderRenameValue.trim()}>
                Rename
              </button>
            </div>
          </form>
        </Modal>
      )}

      {confirmDelete && (
        <Modal title="Delete video" onClose={() => setConfirmDelete(null)}>
          <div className="modal-form">
            <p className="modal-text">
              “{confirmDelete.title}” will move to the {navigator.platform.toLowerCase().includes('mac') ? 'Trash' : 'recycle bin'}
              {confirmDelete.share ? ' and its shared copy will be removed' : ''}. You can restore it from there.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={() => {
                  void window.openloom
                    .deleteVideo(confirmDelete.id)
                    .then(onChanged)
                    .then(() => push('success', 'Video deleted.'))
                    .catch((err) => push('error', cleanIpcError(err)));
                  setConfirmDelete(null);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
