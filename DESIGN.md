# Open Loom - design system

Tokens live in `packages/shared/design-tokens.css` (`--ol-*`). This file states the law; the
tokens implement it.

## Color

- **Strategy: Restrained.** Tinted neutrals + the violet accent (`--ol-accent: #635bff`) on
  primary actions, selection and live state only. Status colours (`--ol-success/danger/warning/
  record`) convey state, never decoration.
- Light + dark themes; `prefers-color-scheme` default, `[data-theme]` override. Never `#000`/`#fff`
  raw: neutrals are Apple-tinted (`#1d1d1f`, `#f5f5f7`).

## Surfaces

Two families, two materials:

1. **In-app surfaces** (main window views): opaque `--ol-surface` cards on `--ol-bg`, hairline
   `--ol-border`, `--ol-elev-card` at most. Real `backdrop-filter` allowed only where page content
   sits behind (toasts, scrims, sidebar).
2. **Overlay surfaces** (launcher, HUD, bubble, countdown, draw toolbar - floating windows over
   the desktop): **faux glass**, because there is no page content behind a transparent window to
   blur. Recipe: dark base `rgba(18-24, 18-24, 22-28, 0.82-0.92)` + top-left light sweep
   `linear-gradient(155deg, rgba(255,255,255,.10-.16), transparent ~40%)` + 1px light border
   `rgba(255,255,255,.22-.30)` + soft ambient shadow. Never pure flat panels.

## Loading and states

- **Thin ring** for indeterminate waits: 2px circle, `rgba(255,255,255,.14-.16)` track, accent
  arc, 0.9s linear spin. Never fat spinners, never system defaults, never green anything.
- **Shimmer skeleton** for content areas (players, lists): 1.4s sweep, low-contrast.
- **No raw video surfaces**: `<video>` starts at opacity 0 and fades in (180ms) on `loadeddata`;
  poster from the recording's own thumbnail; skeleton on top until ready. The bare element paints
  green garbage otherwise - treat that as a defect class, not a styling choice.
- Every interactive component ships default/hover/focus/active/disabled/loading/error.

## Typography

System stack (`--ol-font`), one family everywhere. Fixed px scale 11-28, tabular numerals for
timers. Weight contrast over size contrast in dense UI.

## Motion

`--ol-ease: cubic-bezier(0.32, 0.72, 0.24, 1)`, 120ms (`fast`) / 180ms (default); 150-250ms cap.
Motion conveys state only: fades on readiness, slide-in for the draw toolbar, pop on countdown
digits. No bounce, no page-load choreography, no layout-property animation.

## Bans (project-specific, on top of impeccable's)

- Glow/blur/shadow as a highlight device (renders as artefacts in exports).
- Raw `<video>`/camera surfaces before frames exist.
- Green/system-default loading states.
- Side-stripe borders, gradient text, hero-metric tiles, identical card grids.
- Controls inside captured overlay windows (they end up in the client's video).
