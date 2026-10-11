import { Moon, Sun } from 'lucide-react';
import { resolveTheme, useSettings } from '@/lib/settingsStore';
import { IconButton } from './Button';

export function ThemeToggle() {
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const current = resolveTheme(theme);
  const next = current === 'dark' ? 'light' : 'dark';
  return (
    <IconButton
      icon={current === 'dark' ? Sun : Moon}
      label={`Switch to ${next} theme`}
      onClick={() => {
        setTheme(next);
      }}
    />
  );
}
