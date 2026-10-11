import { useEffect, useId, useState, type ReactNode } from 'react';
import { cx } from './cx';

interface TooltipProps {
  content: ReactNode;
  children: (aria: { 'aria-describedby': string | undefined }) => ReactNode;
  placement?: 'top' | 'bottom';
  align?: 'center' | 'end';
}

/**
 * Lightweight tooltip: shown on hover and keyboard focus, dismissed with Escape (WCAG 1.4.13).
 * The trigger receives `aria-describedby` so the text is also announced.
 */
export function Tooltip({ content, children, placement = 'top', align = 'center' }: TooltipProps) {
  const id = useId();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const visible = (hover || focus) && !dismissed && Boolean(content);

  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDismissed(true);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [visible]);

  return (
    <span
      className={cx(
        'st-tip',
        placement === 'bottom' && 'st-tip--bottom',
        align === 'end' && 'st-tip--end',
      )}
      onMouseEnter={() => {
        setDismissed(false);
        setHover(true);
      }}
      onMouseLeave={() => {
        setHover(false);
      }}
      onFocus={() => {
        setDismissed(false);
        setFocus(true);
      }}
      onBlur={() => {
        setFocus(false);
      }}
    >
      {children({ 'aria-describedby': content ? id : undefined })}
      {content ? (
        <span role="tooltip" id={id} className="st-tip__bubble" hidden={!visible}>
          {content}
        </span>
      ) : null}
    </span>
  );
}
