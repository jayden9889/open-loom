/**
 * Share dialog (SPEC S4): provider status, share link + copy, embed snippet,
 * privacy (link / password), CTA button config, viewer permission toggles and
 * remote deletion. Works standalone; a view mounts it with the video meta.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JobProgress, Settings, VideoMeta } from '@shared/types';
import { Modal, Segmented, Toggle, cleanIpcError, useToasts } from '../ui';
import { Icon } from '../icons';
import './share.css';

type ShareBlock = NonNullable<VideoMeta['share']>;

export interface ShareDialogProps {
  video: VideoMeta;
  onClose: () => void;
  /** Called with fresh meta after every successful change. */
  onChange?: (meta: VideoMeta) => void;
  /** When provided, the unconfigured state offers a jump to Settings. */
  onOpenSharingSettings?: () => void;
}

function providerName(kind: string): string {
  if (kind === 'server') return 'OpenLoom Server';
  if (kind === 's3') return 'S3 bucket';
  return 'Not configured';
}

function embedSnippetFor(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `<iframe src="${url}${sep}embed=1" width="640" height="400" frameborder="0" allow="fullscreen" allowfullscreen title="Open Loom video"></iframe>`;
}

export function ShareDialog({ video, onClose, onChange, onOpenSharingSettings }: ShareDialogProps) {
  const toasts = useToasts();
  const [meta, setMeta] = useState<VideoMeta>(video);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<JobProgress | null>(null);
  const [privacyChoice, setPrivacyChoice] = useState<'link' | 'password'>(video.share?.privacy ?? 'link');
  const [password, setPassword] = useState('');
  const [ctaLabel, setCtaLabel] = useState(video.share?.cta?.label ?? '');
  const [ctaUrl, setCtaUrl] = useState(video.share?.cta?.url ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const share: ShareBlock | undefined = meta.share;

  useEffect(() => {
    void window.openloom.getSettings().then(setSettings);
  }, []);

  useEffect(
    () =>
      window.openloom.onJobProgress((j) => {
        if (j.kind === 'upload' && j.videoId === video.id) setUpload(j);
      }),
    [video.id]
  );

  const refresh = useCallback(async () => {
    const fresh = await window.openloom.getVideo(video.id);
    setMeta(fresh);
    onChange?.(fresh);
    return fresh;
  }, [video.id, onChange]);

  const run = useCallback(
    async (action: () => Promise<unknown>, successToast?: string) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await refresh();
        if (successToast) toasts.push('success', successToast);
        return true;
      } catch (err) {
        setError(cleanIpcError(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh, toasts]
  );

  const applyShareSettings = useCallback(
    (patch: Partial<ShareBlock>, successToast?: string) =>
      run(() => window.openloom.updateShareSettings(video.id, patch), successToast),
    [run, video.id]
  );

  const providerKind = share?.provider ?? settings?.sharing.provider ?? 'none';
  const providerConfigured = useMemo(() => {
    if (!settings) return false;
    if (providerKind === 'server') return settings.sharing.server.url.trim().length > 0;
    if (providerKind === 's3') {
      return settings.sharing.s3.bucket.trim().length > 0 && settings.sharing.s3.publicBaseUrl.trim().length > 0;
    }
    return false;
  }, [settings, providerKind]);

  const isServer = providerKind === 'server';
  const uploadFailed = upload?.note?.startsWith('Upload failed') ?? false;
  const uploading = upload !== null && upload.pct < 100 && !uploadFailed;

  const copy = (text: string, what: string): void => {
    window.openloom.copyToClipboard(text);
    toasts.push('success', `${what} copied to clipboard`);
  };

  return (
    <Modal title="Share" onClose={onClose} width={480}>
      <div className="shr-body">
        <div className="shr-provider">
          <span className="shr-provider-icon">
            <Icon.Link width={16} height={16} />
          </span>
          <div>
            <div className="shr-provider-name">{providerName(providerKind)}</div>
            <div className="shr-provider-sub">
              {providerKind === 'none'
                ? 'Pick a provider in Settings to share videos.'
                : isServer
                  ? 'Hosted watch page with comments, reactions and analytics.'
                  : 'Static player page on your own bucket.'}
            </div>
          </div>
          <span className={`shr-status-pill ${share || providerConfigured ? 'ok' : 'off'}`}>
            {share ? 'Shared' : providerConfigured ? 'Ready' : 'Not set up'}
          </span>
        </div>

        {error && <div className="shr-error">{error}</div>}

        {!share ? (
          <>
            {providerKind === 'none' || !providerConfigured ? (
              <div className="shr-section">
                <p className="shr-hint">
                  {providerKind === 'none'
                    ? 'Sharing is off. Choose the OpenLoom Server (full watch page with comments and analytics) or an S3 bucket in Settings, then Sharing.'
                    : 'The selected provider is missing details. Finish its setup in Settings, then Sharing, and come back.'}
                </p>
                {onOpenSharingSettings && (
                  <div>
                    <button type="button" className="btn-secondary" onClick={onOpenSharingSettings}>
                      Open sharing settings
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="shr-section">
                <p className="shr-hint">
                  Sharing mints a link right away and uploads the video in the background. The page shows a
                  processing state until the upload lands.
                </p>
                <div>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const { url } = await window.openloom.shareVideo(video.id);
                        window.openloom.copyToClipboard(url);
                      }, 'Link copied - uploading in the background')
                    }
                  >
                    {busy ? 'Sharing…' : 'Share and copy link'}
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="shr-section">
              <span className="shr-label">Share link</span>
              <div className="shr-link-row">
                <span className="shr-link" title={share.url}>
                  <Icon.Link width={13} height={13} />
                  <span>{share.url}</span>
                </span>
                <button type="button" className="btn-secondary" onClick={() => copy(share.url, 'Link')}>
                  Copy
                </button>
              </div>
              {isServer && (
                <div>
                  <button
                    type="button"
                    className="btn-secondary btn-small"
                    onClick={() => copy(embedSnippetFor(share.url), 'Embed code')}
                  >
                    Copy embed code
                  </button>
                </div>
              )}
              {(uploading || uploadFailed) && upload && (
                <div className="shr-progress">
                  <div className="shr-progress-track">
                    <div className="shr-progress-fill" style={{ width: `${uploadFailed ? 100 : upload.pct}%` }} />
                  </div>
                  <span className={`shr-progress-note${uploadFailed ? ' failed' : ''}`}>
                    {uploadFailed ? upload.note : `${upload.note ?? 'Uploading'} (${upload.pct}%)`}
                  </span>
                </div>
              )}
              {uploadFailed && (
                <div>
                  <button
                    type="button"
                    className="btn-secondary btn-small"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        setUpload(null);
                        await window.openloom.shareVideo(video.id);
                      }, 'Upload restarted')
                    }
                  >
                    Retry upload
                  </button>
                </div>
              )}
            </div>

            <hr className="shr-divider" />

            <div className="shr-section">
              <span className="shr-label">Privacy</span>
              {isServer ? (
                <>
                  <Segmented<'link' | 'password'>
                    options={[
                      { value: 'link', label: 'Anyone with the link' },
                      { value: 'password', label: 'Password' },
                    ]}
                    value={privacyChoice}
                    onChange={(v) => {
                      setPrivacyChoice(v);
                      if (v === 'link' && share.privacy === 'password') {
                        void applyShareSettings({ privacy: 'link', password: '' }, 'Password removed');
                      }
                    }}
                  />
                  {privacyChoice === 'password' && (
                    <div className="shr-inline">
                      <input
                        className="shr-input"
                        type="password"
                        placeholder={share.privacy === 'password' ? 'New password' : 'Choose a password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="new-password"
                      />
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={busy || password.length < 4}
                        onClick={() =>
                          void applyShareSettings({ privacy: 'password', password }, 'Password set').then(
                            (ok) => ok && setPassword('')
                          )
                        }
                      >
                        {share.privacy === 'password' ? 'Change' : 'Set password'}
                      </button>
                    </div>
                  )}
                  {privacyChoice === 'password' && password.length > 0 && password.length < 4 && (
                    <span className="shr-hint">Passwords need at least 4 characters.</span>
                  )}
                </>
              ) : (
                <p className="shr-hint">
                  S3 shares are public to anyone with the link. Password protection needs the OpenLoom Server
                  provider.
                </p>
              )}
            </div>

            <hr className="shr-divider" />

            <div className="shr-section">
              <span className="shr-label">Viewers can</span>
              {isServer && (
                <>
                  <div className="shr-row">
                    <div className="shr-row-text">
                      <div className="shr-row-title">Comment</div>
                      <div className="shr-row-sub">Timestamped, threaded comments on the watch page</div>
                    </div>
                    <Toggle
                      checked={share.allowComments}
                      disabled={busy}
                      label="Allow comments"
                      onChange={(v) => void applyShareSettings({ allowComments: v })}
                    />
                  </div>
                  <div className="shr-row">
                    <div className="shr-row-text">
                      <div className="shr-row-title">React</div>
                      <div className="shr-row-sub">Emoji reactions, one per viewer per emoji</div>
                    </div>
                    <Toggle
                      checked={share.allowReactions}
                      disabled={busy}
                      label="Allow reactions"
                      onChange={(v) => void applyShareSettings({ allowReactions: v })}
                    />
                  </div>
                </>
              )}
              <div className="shr-row">
                <div className="shr-row-text">
                  <div className="shr-row-title">Download</div>
                  <div className="shr-row-sub">
                    {isServer ? 'Adds a download button to the watch page' : 'Shows a download button on the player page'}
                  </div>
                </div>
                <Toggle
                  checked={share.allowDownload}
                  disabled={busy}
                  label="Allow download"
                  onChange={(v) => void applyShareSettings({ allowDownload: v })}
                />
              </div>
            </div>

            <hr className="shr-divider" />

            <div className="shr-section">
              <span className="shr-label">Call-to-action button</span>
              <div className="shr-inline">
                <input
                  className="shr-input"
                  type="text"
                  placeholder="Label, e.g. Book a call"
                  maxLength={80}
                  value={ctaLabel}
                  onChange={(e) => setCtaLabel(e.target.value)}
                />
                <input
                  className="shr-input"
                  type="url"
                  placeholder="https://…"
                  value={ctaUrl}
                  onChange={(e) => setCtaUrl(e.target.value)}
                />
              </div>
              <div className="shr-inline">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy || !ctaLabel.trim() || !/^https?:\/\//.test(ctaUrl)}
                  onClick={() =>
                    void applyShareSettings({ cta: { label: ctaLabel.trim(), url: ctaUrl.trim() } }, 'CTA saved')
                  }
                >
                  Save CTA
                </button>
                {share.cta && (
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy}
                    onClick={() =>
                      void applyShareSettings({ cta: undefined }, 'CTA removed').then((ok) => {
                        if (ok) {
                          setCtaLabel('');
                          setCtaUrl('');
                        }
                      })
                    }
                  >
                    Remove
                  </button>
                )}
              </div>
              {ctaUrl && !/^https?:\/\//.test(ctaUrl) && (
                <span className="shr-hint">The CTA link must start with http:// or https://.</span>
              )}
            </div>

            <hr className="shr-divider" />

            <div className="shr-danger-zone">
              <span className="shr-danger-text">
                {confirmDelete
                  ? 'This removes the video from the share destination. The local copy stays.'
                  : 'Remove the uploaded copy and disable the link.'}
              </span>
              {confirmDelete ? (
                <>
                  <button type="button" className="btn-secondary" onClick={() => setConfirmDelete(false)}>
                    Keep
                  </button>
                  <button
                    type="button"
                    className="btn-danger"
                    disabled={busy}
                    onClick={() =>
                      void run(() => window.openloom.unshareVideo(video.id), 'Remote copy deleted').then((ok) => {
                        if (ok) {
                          setConfirmDelete(false);
                          setUpload(null);
                        }
                      })
                    }
                  >
                    Delete remote copy
                  </button>
                </>
              ) : (
                <button type="button" className="btn-danger-quiet" onClick={() => setConfirmDelete(true)}>
                  <Icon.Trash width={14} height={14} /> Delete remote copy
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
