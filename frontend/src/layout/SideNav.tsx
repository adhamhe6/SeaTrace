import { Bell, Info, Play, Ship, FlaskConical, LayoutDashboard } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useVessels } from '@/api/hooks';
import { cx } from '@/ui/cx';

const LINKS = [
  { to: '/', label: 'Fleet overview', icon: LayoutDashboard, end: true },
  { to: '/alarms', label: 'Alarm center', icon: Bell, end: false },
  { to: '/replay', label: 'Incident replay', icon: Play, end: false },
  { to: '/simulator', label: 'Simulator', icon: FlaskConical, end: false },
  { to: '/about', label: 'About', icon: Info, end: false },
] as const;

export function SideNav({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const vessels = useVessels();
  return (
    <>
      <div
        className={cx('nav__backdrop', open && 'is-open')}
        aria-hidden="true"
        onClick={onNavigate}
      />
      <aside className={cx('shell__nav', open && 'is-open')} id="primary-nav">
        <nav className="nav" aria-label="Primary">
          {LINKS.slice(0, 4).map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className="nav__link"
              onClick={onNavigate}
            >
              <link.icon size={16} aria-hidden="true" />
              {link.label}
            </NavLink>
          ))}
          <p className="nav__heading" id="nav-vessels">
            Vessels
          </p>
          <div role="group" aria-labelledby="nav-vessels" style={{ display: 'contents' }}>
            {vessels.data?.map((vessel) => (
              <NavLink
                key={vessel.code}
                to={`/vessels/${vessel.code}`}
                className="nav__link"
                onClick={onNavigate}
              >
                <Ship size={16} aria-hidden="true" />
                <span>
                  {vessel.name}
                  <span className="muted" style={{ display: 'block', fontSize: 'var(--fs-xs)' }}>
                    {vessel.code}
                  </span>
                </span>
              </NavLink>
            ))}
            {vessels.isError ? (
              <p className="muted" style={{ padding: '0 var(--s-2)', fontSize: 'var(--fs-xs)' }}>
                Vessel list unavailable
              </p>
            ) : null}
          </div>
          <p className="nav__heading">Project</p>
          {LINKS.slice(4).map((link) => (
            <NavLink key={link.to} to={link.to} className="nav__link" onClick={onNavigate}>
              <link.icon size={16} aria-hidden="true" />
              {link.label}
            </NavLink>
          ))}
        </nav>
      </aside>
    </>
  );
}
