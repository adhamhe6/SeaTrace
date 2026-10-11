import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem {
  id: string;
  label: ReactNode;
  count?: number;
}

interface TabsProps {
  items: readonly TabItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  /** Prefix for generated ids so panels can reference tabs. */
  idBase?: string;
}

export function tabId(base: string, id: string): string {
  return `${base}-tab-${id}`;
}
export function panelId(base: string, id: string): string {
  return `${base}-panel-${id}`;
}

/** Accessible tab list (roving tabindex, arrow/Home/End keys). Panels are rendered by the caller. */
export function Tabs({ items, value, onChange, label, idBase }: TabsProps) {
  const generated = useId();
  const base = idBase ?? generated;
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((i) => i.id === value);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    const target = items[next];
    if (!target) return;
    onChange(target.id);
    refs.current[target.id]?.focus();
  };

  return (
    // eslint-disable-next-line jsx-a11y/interactive-supports-focus -- focus is managed on the tab buttons (roving tabindex)
    <div className="st-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item) => (
        <button
          key={item.id}
          ref={(el) => {
            refs.current[item.id] = el;
          }}
          type="button"
          role="tab"
          id={tabId(base, item.id)}
          aria-selected={item.id === value}
          aria-controls={panelId(base, item.id)}
          tabIndex={item.id === value ? 0 : -1}
          className="st-tab"
          onClick={() => {
            onChange(item.id);
          }}
        >
          {item.label}
          {item.count !== undefined ? <span className="st-tab__count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({
  base,
  id,
  active,
  children,
}: {
  base: string;
  id: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={panelId(base, id)}
      aria-labelledby={tabId(base, id)}
      hidden={!active}
      tabIndex={0}
    >
      {active ? children : null}
    </div>
  );
}
