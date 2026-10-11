import {
  Anchor,
  ChevronDown,
  LogOut,
  Menu,
  Radio,
  RadioTower,
  TriangleAlert,
  WifiOff,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useFleetSummary, useSystemStatus } from '@/api/hooks';
import type { OpcUaStatus, Severity } from '@/api/types';
import { useAuth } from '@/auth/authStore';
import { SEVERITY, type Tone } from '@/lib/domain';
import { formatAge } from '@/lib/format';
import { useSettings } from '@/lib/settingsStore';
import { useNow } from '@/lib/useNow';
import { useLive, type ConnectionState } from '@/realtime/liveStore';
import { Button, IconButton } from '@/ui/Button';
import { RoleBadge } from '@/ui/Badge';
import { Segmented } from '@/ui/Choice';
import { cx } from '@/ui/cx';
import { Skeleton } from '@/ui/Skeleton';
import { ThemeToggle } from '@/ui/ThemeToggle';
import { Tooltip } from '@/ui/Tooltip';
import { toMs } from '@/lib/format';

const OPC_TONE: Record<OpcUaStatus['state'], Tone> = {
  connected: 'ok',
  connecting: 'warning',
  backoff: 'warning',
  disconnected: 'critical',
  disabled: 'offline',
  stopped: 'offline',
};

const OPC_LABEL: Record<OpcUaStatus['state'], string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  backoff: 'Reconnecting',
  disconnected: 'Disconnected',
  disabled: 'Disabled',
  stopped: 'Stopped',
};

const LIVE_TONE: Record<ConnectionState, Tone> = {
  open: 'ok',
  connecting: 'warning',
  reconnecting: 'warning',
  closed: 'offline',
};

const LIVE_LABEL: Record<ConnectionState, string> = {
  open: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  closed: 'Closed',
};

export function SourceStatusChip() {
  const system = useSystemStatus();
  const pushed = useLive((s) => s.sourceStatus);
  const now = useNow();
  const status = pushed ?? system.data?.opcua ?? null;
  if (!status) {
    return (
      <span className="chip st-tone-offline">
        <RadioTower size={13} aria-hidden="true" />
        OPC UA: {system.isError ? 'unknown' : 'loading'}
      </span>
    );
  }
  const lastData = toMs(status.last_data_at);
  const age = lastData === null ? null : Math.max(0, (now - lastData) / 1000);
  const tip = `${status.endpoint} (${status.security === 'secure' ? 'secure channel' : 'no security'}). Last data: ${formatAge(age)}`;
  return (
    <Tooltip content={tip} placement="bottom">
      {(aria) => (
        <Link
          {...aria}
          to="/simulator"
          className={cx('chip', `st-tone-${OPC_TONE[status.state]}`)}
          style={{ textDecoration: 'none' }}
        >
          <RadioTower size={13} aria-hidden="true" />
          <span>
            OPC UA: <span data-testid="opcua-state">{OPC_LABEL[status.state]}</span>
          </span>
        </Link>
      )}
    </Tooltip>
  );
}

export function LiveChannelChip() {
  const connection = useLive((s) => s.connection);
  const Icon = connection === 'open' ? Radio : connection === 'closed' ? WifiOff : TriangleAlert;
  return (
    <span className={cx('chip', `st-tone-${LIVE_TONE[connection]}`)}>
      <Icon size={13} aria-hidden="true" />
      <span>
        Live: <span data-testid="live-state">{LIVE_LABEL[connection]}</span>
      </span>
    </span>
  );
}

function AlarmCounters() {
  const { data, isPending, isError } = useFleetSummary();
  if (isPending) return <Skeleton width={220} height={24} />;
  if (isError) return <span className="muted">Alarm counters unavailable</span>;
  const counters: { severity: Severity; count: number }[] = [
    { severity: 'critical', count: data.open_alarms.critical },
    { severity: 'warning', count: data.open_alarms.warning },
    { severity: 'info', count: data.open_alarms.info },
  ];
  return (
    <nav aria-label="Open alarms" className="statusbar">
      {counters.map(({ severity, count }) => {
        const d = SEVERITY[severity];
        return (
          <Link
            key={severity}
            to={`/alarms?severity=${severity}`}
            className={cx('counter', `st-tone-${d.tone}`, count === 0 && 'is-zero')}
          >
            <d.icon size={14} aria-hidden="true" />
            <span>{d.label}</span>
            <span className="counter__n">{count}</span>
          </Link>
        );
      })}
      <Link
        to="/alarms?tab=open&state=active_unacknowledged&state=cleared_unacknowledged"
        className={cx(
          'counter',
          'st-tone-neutral',
          data.open_alarms.unacknowledged === 0 && 'is-zero',
        )}
      >
        <span>Unacknowledged</span>
        <span className="counter__n">{data.open_alarms.unacknowledged}</span>
      </Link>
    </nav>
  );
}

function TimeModeToggle() {
  const mode = useSettings((s) => s.timeMode);
  const setMode = useSettings((s) => s.setTimeMode);
  return (
    <Segmented
      label="Time zone"
      value={mode}
      onChange={setMode}
      options={[
        { value: 'utc', label: 'UTC' },
        { value: 'local', label: 'Local' },
      ]}
    />
  );
}

function UserMenu() {
  const user = useAuth((s) => s.user);
  const signOut = useAuth((s) => s.signOut);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;
  return (
    <div className="usermenu" ref={rootRef}>
      <button
        type="button"
        className="usermenu__button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <span>{user.username}</span>
        <RoleBadge role={user.role} />
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="usermenu__panel">
          <div>
            <p className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
              Signed in as
            </p>
            <p style={{ fontWeight: 600 }}>{user.username}</p>
            <p className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
              {user.role === 'operator'
                ? 'Operator: can acknowledge alarms and control the simulator.'
                : 'Viewer: read-only access.'}
            </p>
          </div>
          <Button
            icon={LogOut}
            onClick={() => {
              signOut();
            }}
          >
            Sign out
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function TopBar({ onToggleNav, navOpen }: { onToggleNav: () => void; navOpen: boolean }) {
  return (
    <header className="shell__header">
      <div className="topbar">
        <IconButton
          className="topbar__menu"
          icon={Menu}
          label={navOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={navOpen}
          aria-controls="primary-nav"
          onClick={onToggleNav}
        />
        <Link to="/" className="topbar__brand">
          <Anchor size={20} aria-hidden="true" />
          SeaTrace
        </Link>
        <span className="sim-flag" role="note">
          <TriangleAlert size={13} aria-hidden="true" />
          Simulated data — not a real vessel
        </span>
        <span className="topbar__spacer" />
        <div className="topbar__group">
          <TimeModeToggle />
          <ThemeToggle />
          <UserMenu />
        </div>
        <div className="statusbar" style={{ flexBasis: '100%' }}>
          <AlarmCounters />
          <span className="topbar__spacer" />
          <SourceStatusChip />
          <LiveChannelChip />
        </div>
      </div>
    </header>
  );
}
