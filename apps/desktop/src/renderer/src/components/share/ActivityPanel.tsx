/**
 * Activity panel (SPEC V3 in-app rendering): live viewer analytics from the
 * share server. Stat tiles, views-by-day bar chart, watch-coverage heat
 * strip, viewer list, reactions and comments. No chart libraries: bars and
 * the heat strip are token-styled divs.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ShareActivity, ShareComment, VideoMeta } from '@shared/types';
import { cleanIpcError, formatDuration, useToasts } from '../ui';
import { Icon } from '../icons';
import './share.css';

export interface ActivityPanelProps {
  video: VideoMeta;
  /** Seek the in-app player when a comment timestamp chip is clicked. */
  onSeek?: (sec: number) => void;
}

function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function relativeWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Last 14 calendar days, zero-filled so the chart always has a stable axis. */
function chartDays(viewsByDay: { day: string; views: number }[]): { day: string; views: number }[] {
  const map = new Map(viewsByDay.map((v) => [v.day, v.views]));
  const out: { day: string; views: number }[] = [];
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, views: map.get(key) ?? 0 });
  }
  return out;
}

export function ActivityPanel({ video, onSeek }: ActivityPanelProps) {
  const toasts = useToasts();
  const [activity, setActivity] = useState<ShareActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    window.openloom
      .getShareActivity(video.id)
      .then(setActivity)
      .catch((err) => setError(cleanIpcError(err)))
      .finally(() => setLoading(false));
  }, [video.id]);

  useEffect(() => {
    if (video.share?.provider === 'server') load();
  }, [video.share?.provider, load]);

  const days = useMemo(() => (activity ? chartDays(activity.viewsByDay) : []), [activity]);
  const maxDay = useMemo(() => Math.max(1, ...days.map((d) => d.views)), [days]);

  if (!video.share) {
    return (
      <div className="act-empty">
        <Icon.Link width={28} height={28} />
        <strong>Not shared yet</strong>
        <span>Share this video to see who watched, reacted and commented.</span>
      </div>
    );
  }

  if (video.share.provider !== 'server') {
    return (
      <div className="act-empty">
        <Icon.Warning width={28} height={28} />
        <strong>No analytics for S3 shares</strong>
        <span>
          Static bucket pages cannot report views or comments. Use the OpenLoom Server provider for the full
          activity loop.
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="act-empty">
        <Icon.Warning width={28} height={28} />
        <strong>Activity unavailable</strong>
        <span>{error}</span>
        <button type="button" className="btn-secondary" onClick={load}>
          Try again
        </button>
      </div>
    );
  }

  if (!activity) {
    return (
      <div className="act-empty">
        <span>{loading ? 'Loading activity…' : 'No activity loaded yet.'}</span>
      </div>
    );
  }

  const topComments = activity.comments.filter((c) => !c.parentId);
  const repliesFor = (id: string): ShareComment[] => activity.comments.filter((c) => c.parentId === id);
  const canDeleteComments = typeof window.openloom.deleteShareComment === 'function';

  const deleteComment = (commentId: string): void => {
    void window.openloom
      .deleteShareComment(video.id, commentId)
      .then(() => {
        toasts.push('success', 'Comment deleted');
        load();
      })
      .catch((err) => toasts.push('error', cleanIpcError(err)));
  };

  const commentCard = (c: ShareComment, reply: boolean) => (
    <div key={c.id} className={`act-comment${reply ? ' reply' : ''}`}>
      <div className="act-comment-head">
        <span className="act-avatar">{(c.author || 'A').slice(0, 1).toUpperCase()}</span>
        <span className="act-comment-author">{c.author}</span>
        {typeof c.atSec === 'number' && (
          <button
            type="button"
            className="act-comment-at"
            title={`Jump to ${formatDuration(c.atSec)}`}
            onClick={() => onSeek?.(c.atSec as number)}
          >
            {formatDuration(c.atSec)}
          </button>
        )}
        <span className="act-comment-when">{relativeWhen(c.createdAt)}</span>
        {canDeleteComments && (
          <button
            type="button"
            className="act-comment-del"
            aria-label="Delete comment"
            title="Delete comment"
            onClick={() => deleteComment(c.id)}
          >
            <Icon.Trash width={13} height={13} />
          </button>
        )}
      </div>
      <div className="act-comment-text">{c.text}</div>
    </div>
  );

  return (
    <div className="act-panel">
      <div className="act-head">
        <h4>Viewer activity</h4>
        <button type="button" className="btn-secondary btn-small" onClick={load} disabled={loading}>
          <Icon.Refresh width={13} height={13} /> {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="act-stats">
        <div className="act-stat">
          <span className="act-stat-value">{activity.views}</span>
          <span className="act-stat-label">Views</span>
        </div>
        <div className="act-stat">
          <span className="act-stat-value">{activity.uniqueViewers}</span>
          <span className="act-stat-label">Unique viewers</span>
        </div>
        <div className="act-stat">
          <span className="act-stat-value">{Math.round(activity.completionRate * 100)}%</span>
          <span className="act-stat-label">Avg completion</span>
        </div>
      </div>

      <div className="act-block">
        <span className="act-block-title">Views, last 14 days</span>
        <div className="act-chart" role="img" aria-label="Views per day over the last 14 days">
          {days.map((d, i) => (
            <div key={d.day} className="act-bar-col" title={`${dayLabel(d.day)}: ${d.views} view${d.views === 1 ? '' : 's'}`}>
              <div
                className={`act-bar${d.views === 0 ? ' zero' : ''}`}
                style={{ height: d.views === 0 ? '2px' : `${Math.max(8, (d.views / maxDay) * 100)}%` }}
              />
              {(i === 0 || i === days.length - 1) && <span className="act-bar-label">{dayLabel(d.day)}</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="act-block">
        <span className="act-block-title">Watch coverage</span>
        <div className="act-heat" role="img" aria-label="How much of the timeline viewers watched">
          {activity.coverage.map((v, i) => (
            <div
              key={i}
              className="act-heat-cell"
              style={{ opacity: v === 0 ? 0.08 : 0.15 + v * 0.85 }}
              title={`${Math.round((i / activity.coverage.length) * 100)}% in: watched by ${Math.round(v * 100)}% of viewers`}
            />
          ))}
        </div>
        <div className="act-heat-scale">
          <span>0:00</span>
          <span>{formatDuration(video.durationSec)}</span>
        </div>
      </div>

      <div className="act-block">
        <span className="act-block-title">Viewers</span>
        {activity.viewers.length === 0 ? (
          <span className="shr-hint">Nobody has opened the link yet. Send it out.</span>
        ) : (
          <div className="act-viewers">
            {activity.viewers.map((v, i) => (
              <div key={`${v.name}-${i}`} className="act-viewer">
                <span className="act-avatar">{v.name.slice(0, 1).toUpperCase()}</span>
                <span className="act-viewer-name">{v.name}</span>
                <span className="act-viewer-meta">
                  watched to {formatDuration(v.maxPositionSec)}
                  {v.sessions > 1 ? ` · ${v.sessions} visits` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {Object.keys(activity.reactions).length > 0 && (
        <div className="act-block">
          <span className="act-block-title">Reactions</span>
          <div className="act-reactions">
            {Object.entries(activity.reactions).map(([emoji, count]) => (
              <span key={emoji} className="act-reaction">
                <span>{emoji}</span>
                <span className="n">{count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="act-block">
        <span className="act-block-title">Comments ({activity.comments.length})</span>
        {topComments.length === 0 ? (
          <span className="shr-hint">No comments yet.</span>
        ) : (
          <div className="act-comments">
            {topComments.map((c) => (
              <div key={c.id}>
                {commentCard(c, false)}
                {repliesFor(c.id).map((r) => commentCard(r, true))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
