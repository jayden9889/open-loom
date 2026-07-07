/**
 * Inline SF-Symbols-style icon set, stroke 1.8 (SPEC D1).
 */
import type { SVGProps } from 'react';

function base(props: SVGProps<SVGSVGElement>, children: React.ReactNode, filled = false) {
  const { width = 18, height = 18, ...rest } = props;
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Icon = {
  Record: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <circle cx="12" cy="12" r="8.5" />
        <circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none" />
      </>
    ),
  Library: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
        <path d="m10 9.5 5 2.5-5 2.5z" fill="currentColor" stroke="none" />
      </>
    ),
  Folder: (p: SVGProps<SVGSVGElement>) =>
    base(p, <path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h3.2c.7 0 1.3.3 1.8.8l1 1.2H18A2.5 2.5 0 0 1 20.5 9v8A2.5 2.5 0 0 1 18 19.5H6A2.5 2.5 0 0 1 3.5 17Z" />),
  FolderPlus: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h3.2c.7 0 1.3.3 1.8.8l1 1.2H18A2.5 2.5 0 0 1 20.5 9v8A2.5 2.5 0 0 1 18 19.5H6A2.5 2.5 0 0 1 3.5 17Z" />
        <path d="M12 10.5v5M9.5 13h5" />
      </>
    ),
  Settings: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <circle cx="12" cy="12" r="3.2" />
        <path d="M19 12a7 7 0 0 0-.14-1.4l2-1.55-2-3.46-2.35.95a7 7 0 0 0-2.42-1.4L13.7 2.6h-3.4l-.39 2.54a7 7 0 0 0-2.42 1.4l-2.35-.95-2 3.46 2 1.55a7.06 7.06 0 0 0 0 2.8l-2 1.55 2 3.46 2.35-.95a7 7 0 0 0 2.42 1.4l.39 2.54h3.4l.39-2.54a7 7 0 0 0 2.42-1.4l2.35.95 2-3.46-2-1.55A7 7 0 0 0 19 12Z" />
      </>
    ),
  Search: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4.5 4.5" />
      </>
    ),
  Play: (p: SVGProps<SVGSVGElement>) => base(p, <path d="M8 5.5v13l11-6.5z" />, true),
  Pause: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <rect x="7" y="5" width="3.4" height="14" rx="1.2" />
        <rect x="13.6" y="5" width="3.4" height="14" rx="1.2" />
      </>,
      true
    ),
  Back: (p: SVGProps<SVGSVGElement>) => base(p, <path d="M14.5 5.5 8 12l6.5 6.5" />),
  More: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <circle cx="5.5" cy="12" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <circle cx="18.5" cy="12" r="1.6" />
      </>,
      true
    ),
  Screen: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <rect x="3" y="4.5" width="18" height="12.5" rx="2" />
        <path d="M9 20h6" />
      </>
    ),
  Camera: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <rect x="3" y="7" width="12" height="10" rx="2.5" />
        <path d="m15 10.5 5-2.5v8l-5-2.5" />
      </>
    ),
  ScreenCam: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <rect x="3" y="4.5" width="18" height="12.5" rx="2" />
        <path d="M9 20h6" />
        <circle cx="8" cy="13" r="2.6" fill="currentColor" stroke="none" />
      </>
    ),
  Mic: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <rect x="9.2" y="3.5" width="5.6" height="10" rx="2.8" />
        <path d="M6 11.5a6 6 0 0 0 12 0" />
        <path d="M12 17.5V21" />
      </>
    ),
  Speaker: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <path d="M4 9.5v5h3l4 3.5v-12l-4 3.5z" />
        <path d="M15.5 9a4.5 4.5 0 0 1 0 6" />
        <path d="M18 6.5a8 8 0 0 1 0 11" />
      </>
    ),
  VolumeMute: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <path d="M4 9.5v5h3l4 3.5v-12l-4 3.5z" />
        <path d="m15.5 9.5 5 5m0-5-5 5" />
      </>
    ),
  Check: (p: SVGProps<SVGSVGElement>) => base(p, <path d="m5 12.5 4.5 4.5L19 7.5" />),
  Close: (p: SVGProps<SVGSVGElement>) => base(p, <path d="m6 6 12 12M18 6 6 18" />),
  Warning: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <path d="M12 3.5 21.5 20h-19Z" />
        <path d="M12 9.5v5" />
        <circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" />
      </>
    ),
  Download: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <path d="M12 4v11" />
        <path d="m7.5 11 4.5 4.5L16.5 11" />
        <path d="M5 19.5h14" />
      </>
    ),
  Link: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <path d="M10 14a4 4 0 0 0 6 .4l2.5-2.5a4 4 0 1 0-5.7-5.7L11.5 7.5" />
        <path d="M14 10a4 4 0 0 0-6-.4L5.5 12a4 4 0 1 0 5.7 5.7l1.3-1.3" />
      </>
    ),
  Trash: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <path d="M4 7h16" />
        <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
        <path d="M6.5 7 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5L17.5 7" />
      </>
    ),
  Duplicate: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
      </>
    ),
  Pencil: (p: SVGProps<SVGSVGElement>) =>
    base(p, <path d="M4 20c.6-2.7 1.4-4 3-5.7L16.6 4.7a2.1 2.1 0 0 1 3 3L10 17.3c-1.7 1.6-3 2.3-6 2.7Z" />),
  Fullscreen: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <path d="M9 4.5H4.5V9" />
        <path d="M15 4.5h4.5V9" />
        <path d="M9 19.5H4.5V15" />
        <path d="M15 19.5h4.5V15" />
      </>
    ),
  Captions: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
        <path d="M10.5 10.5a2.3 2.3 0 0 0-4 1.5 2.3 2.3 0 0 0 4 1.5" />
        <path d="M17.5 10.5a2.3 2.3 0 0 0-4 1.5 2.3 2.3 0 0 0 4 1.5" />
      </>
    ),
  Clock: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </>
    ),
  Sparkle: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <path d="M12 4c.6 3.6 2.4 5.4 6 6-3.6.6-5.4 2.4-6 6-.6-3.6-2.4-5.4-6-6 3.6-.6 5.4-2.4 6-6Z" />
        <path d="M18.5 15.5c.3 1.7 1.1 2.5 2.8 2.8-1.7.3-2.5 1.1-2.8 2.8-.3-1.7-1.1-2.5-2.8-2.8 1.7-.3 2.5-1.1 2.8-2.8Z" />
      </>
    ),
  Refresh: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <path d="M4 10a8 8 0 1 1 2.3 6.3" />
        <path d="M4 15v-5h5" />
      </>
    ),
  Reveal: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h3.2c.7 0 1.3.3 1.8.8l1 1.2H18A2.5 2.5 0 0 1 20.5 9v8A2.5 2.5 0 0 1 18 19.5H6A2.5 2.5 0 0 1 3.5 17Z" />
        <path d="m12 10.5 0 5M9.7 13.2 12 15.5l2.3-2.3" />
      </>
    ),
  Scissors: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <circle cx="6" cy="6.5" r="2.6" />
        <circle cx="6" cy="17.5" r="2.6" />
        <path d="M8.2 8 20 18.5M8.2 16 20 5.5M14.6 12.8l-2.3 2" />
      </>
    ),
  Split: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <path d="M12 3.5v17" strokeDasharray="2.6 2.6" />
        <rect x="3.5" y="7" width="5.5" height="10" rx="1.5" />
        <rect x="15" y="7" width="5.5" height="10" rx="1.5" />
      </>
    ),
  Plus: (p: SVGProps<SVGSVGElement>) =>
    base(p, <path d="M12 5v14M5 12h14" />),
  Undo: (p: SVGProps<SVGSVGElement>) =>
    base(
      p,
      <>
        <path d="M4.5 9.5h9a5 5 0 0 1 0 10H8" />
        <path d="m8 5.5-4 4 4 4" />
      </>
    ),
};
