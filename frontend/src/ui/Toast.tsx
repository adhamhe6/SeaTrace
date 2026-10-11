import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { IconButton } from './Button';
import type { Tone } from '@/lib/domain';

export interface ToastInput {
  tone: Extract<Tone, 'ok' | 'info' | 'warning' | 'critical'>;
  title: string;
  message?: string;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  push: (toast: ToastInput) => void;
  success: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
  warning: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICONS = { ok: CircleCheck, info: Info, warning: TriangleAlert, critical: CircleX };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-4), { ...toast, id }]);
      timers.current.set(
        id,
        setTimeout(
          () => {
            dismiss(id);
          },
          toast.tone === 'critical' ? 12_000 : 6000,
        ),
      );
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (title, message) => {
        push({ tone: 'ok', title, message });
      },
      info: (title, message) => {
        push({ tone: 'info', title, message });
      },
      warning: (title, message) => {
        push({ tone: 'warning', title, message });
      },
      error: (title, message) => {
        push({ tone: 'critical', title, message });
      },
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="st-toasts">
        {/* Polite live region for confirmations; errors use the assertive one. */}
        <div aria-live="polite" aria-atomic="false" role="status" style={{ display: 'contents' }}>
          {toasts
            .filter((t) => t.tone !== 'critical')
            .map((t) => (
              <ToastView key={t.id} toast={t} onDismiss={dismiss} />
            ))}
        </div>
        <div role="alert" style={{ display: 'contents' }}>
          {toasts
            .filter((t) => t.tone === 'critical')
            .map((t) => (
              <ToastView key={t.id} toast={t} onDismiss={dismiss} />
            ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const Icon = ICONS[toast.tone];
  return (
    <div className={`st-toast st-tone-${toast.tone}`}>
      <Icon size={18} className="st-toast__icon" aria-hidden="true" />
      <div className="st-toast__body">
        <p className="st-toast__title">{toast.title}</p>
        {toast.message ? <p className="st-toast__msg">{toast.message}</p> : null}
      </div>
      <IconButton
        icon={X}
        size="sm"
        label="Dismiss notification"
        tooltip={false}
        onClick={() => {
          onDismiss(toast.id);
        }}
      />
    </div>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
