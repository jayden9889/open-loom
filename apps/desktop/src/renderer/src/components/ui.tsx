/**
 * Small UI primitives shared across views: toasts, context menu, modal,
 * segmented control, toggle switch.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from './icons';

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

interface ToastContextValue {
  push(kind: Toast['kind'], text: string): void;
}

const ToastContext = createContext<ToastContextValue>({ push: () => undefined });

export function useToasts(): ToastContextValue {
  return useContext(ToastContext);
}

let toastSeq = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = toastSeq++;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.kind === 'success' && <Icon.Check width={15} height={15} />}
            {t.kind === 'error' && <Icon.Warning width={15} height={15} />}
            <span>{t.text}</span>
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss"
              onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
            >
              <Icon.Close width={12} height={12} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function cleanIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Electron prefixes invoke rejections with "Error invoking remote method 'x':".
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  submenu?: MenuItem[];
  separatorAfter?: boolean;
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [pos, setPos] = useState({ x, y });

  // Clamp to the viewport before first paint - with useEffect the menu showed
  // clipped at the raw x,y for one frame, then snapped into place.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      setPos({
        x: Math.min(x, window.innerWidth - rect.width - 8),
        y: Math.min(y, window.innerHeight - rect.height - 8),
      });
    }
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => (
        <div key={i} className="menu-item-wrap" onMouseEnter={() => setOpenSub(item.submenu ? i : null)}>
          <button
            type="button"
            role="menuitem"
            className={`menu-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              if (item.submenu) return;
              item.onClick?.();
              onClose();
            }}
          >
            {item.icon && <span className="menu-icon">{item.icon}</span>}
            <span>{item.label}</span>
            {item.submenu && <span className="menu-arrow">›</span>}
          </button>
          {item.submenu && openSub === i && (
            <div className="menu submenu" role="menu">
              {item.submenu.map((sub, j) => (
                <button
                  key={j}
                  type="button"
                  role="menuitem"
                  className={`menu-item${sub.danger ? ' danger' : ''}`}
                  disabled={sub.disabled}
                  onClick={() => {
                    sub.onClick?.();
                    onClose();
                  }}
                >
                  {sub.icon && <span className="menu-icon">{sub.icon}</span>}
                  <span>{sub.label}</span>
                </button>
              ))}
            </div>
          )}
          {item.separatorAfter && <div className="menu-sep" />}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function Modal({
  title,
  onClose,
  children,
  width = 440,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon.Close width={15} height={15} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive actions get the red button rather than the accent one. */
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

/**
 * Asking before something destructive is a product surface, not an OS one: a
 * native window.confirm paints a grey system slab over an Apple-sleek app and
 * blocks the whole renderer while it sits there. This is the same question in
 * the app's own Modal.
 *
 * The default falls back to the native dialog so a call site inside an overlay
 * window (which never mounts this provider) still asks rather than silently
 * proceeding.
 */
const ConfirmContext = createContext<ConfirmFn>(async (opts) =>
  window.confirm(typeof opts.body === 'string' ? opts.body : opts.title)
);

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{
    opts: ConfirmOptions;
    resolve: (value: boolean) => void;
  } | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        setPending((cur) => {
          // Opening a second confirm while one is still up used to drop the
          // first pending promise on the floor, leaving its caller awaiting
          // forever. Settle the one being replaced as a cancel first: nothing
          // destructive ever proceeds on a question the user never saw.
          if (cur) cur.resolve(false);
          return { opts, resolve };
        });
      }),
    []
  );

  // The promise MUST settle on every exit path (button, Escape, scrim click),
  // or the awaiting call site hangs forever holding its own state.
  const settle = (value: boolean): void => {
    if (!pending) return;
    pending.resolve(value);
    setPending(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <Modal title={pending.opts.title} onClose={() => settle(false)}>
          <div className="modal-form">
            <p className="modal-text">{pending.opts.body}</p>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => settle(false)}>
                {pending.opts.cancelLabel ?? 'Cancel'}
              </button>
              <button
                type="button"
                className={pending.opts.danger ? 'btn-danger' : 'btn-primary'}
                onClick={() => settle(true)}
                autoFocus
              >
                {pending.opts.confirmLabel ?? 'Continue'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Segmented control + toggle
// ---------------------------------------------------------------------------

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: ReactNode; title?: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={value === opt.value}
          title={opt.title}
          className={`segment${value === opt.value ? ' selected' : ''}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}
