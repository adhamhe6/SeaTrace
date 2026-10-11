import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useLive } from '@/realtime/liveStore';
import { Banner } from '@/ui/Banner';
import { ErrorBoundary } from './ErrorBoundary';
import { SideNav } from './SideNav';
import { TopBar } from './TopBar';
import './layout.css';

function LiveBanners() {
  const online = useLive((s) => s.online);
  const connection = useLive((s) => s.connection);
  if (!online) {
    return (
      <Banner tone="warning" role="alert" title="You are offline.">
        This browser has no network connection. Showing last known data; it will refresh
        automatically when the connection returns.
      </Banner>
    );
  }
  if (connection === 'reconnecting' || connection === 'closed') {
    return <Banner tone="warning">Live updates paused — showing last known data; retrying…</Banner>;
  }
  return null;
}

function LiveAnnouncer() {
  const announcement = useLive((s) => s.announcement);
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {announcement ? <span key={announcement.id}>{announcement.text}</span> : null}
    </div>
  );
}

export function AppShell() {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  // Move focus to the main landmark on route changes so keyboard and screen-reader users land on new content.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: false });
  }, [location.pathname]);

  const closeNav = useCallback(() => {
    setNavOpen(false);
  }, []);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [navOpen]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <TopBar
        navOpen={navOpen}
        onToggleNav={() => {
          setNavOpen((v) => !v);
        }}
      />
      <SideNav open={navOpen} onNavigate={closeNav} />
      <main id="main" className="shell__main" ref={mainRef} tabIndex={-1}>
        <div className="shell__content">
          <LiveBanners />
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>
      <footer className="shell__footer">
        <p>
          SeaTrace is an independent educational simulation: all vessels and telemetry are
          simulated. Not certified maritime software; not affiliated with or endorsed by NACOS
          Marine. <Link to="/about">About and disclaimer</Link>
        </p>
      </footer>
      <LiveAnnouncer />
    </div>
  );
}
