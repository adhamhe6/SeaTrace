import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Badge, AlarmStateBadge, QualityBadge, SeverityBadge, HealthBadge } from './Badge';
import { Button, IconButton } from './Button';
import { Dialog } from './Dialog';
import { Field, Input } from './Field';
import { DataTable } from './DataTable';
import { MultiSelect, Segmented } from './Choice';
import { RangeBar } from './misc';
import { TabPanel, Tabs } from './Tabs';
import { ToastProvider, useToast } from './Toast';
import { Tooltip } from './Tooltip';
import { ErrorBoundary } from '@/layout/ErrorBoundary';
import { ThemeToggle } from './ThemeToggle';
import { useSettings } from '@/lib/settingsStore';
import { Plus } from 'lucide-react';

describe('Button', () => {
  it('stays focusable but inert when a disabledReason is given, and explains why', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button onClick={onClick} disabledReason="Operator role required">
        Act
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Act' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(button).toHaveFocus(); // never removed from the tab order
    expect(button).toHaveAccessibleDescription('Operator role required');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Operator role required');
  });

  it('is disabled and busy while loading', () => {
    render(<Button loading>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-busy', 'true');
  });

  it('IconButton requires and exposes an accessible name', () => {
    render(<IconButton icon={Plus} label="Add item" />);
    expect(screen.getByRole('button', { name: 'Add item' })).toBeInTheDocument();
  });
});

describe('Tooltip', () => {
  it('shows on focus and hides on Escape', async () => {
    const user = userEvent.setup();
    render(<Tooltip content="Helpful">{(aria) => <button {...aria}>Trigger</button>}</Tooltip>);
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.tab();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Helpful');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('Dialog', () => {
  function Harness({ onClose }: { onClose?: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button
          onClick={() => {
            setOpen(true);
          }}
        >
          Open
        </button>
        <Dialog
          open={open}
          onClose={() => {
            setOpen(false);
            onClose?.();
          }}
          title="Confirm"
          footer={<button>Primary</button>}
        >
          <input aria-label="Name" />
        </Dialog>
      </>
    );
  }

  it('moves focus in, traps Tab, closes on Escape and restores focus to the opener', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Confirm' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    // Tab cycles within the dialog
    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(opener).toHaveFocus();
  });

  it('closes on backdrop click but not while busy', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog open onClose={onClose} title="T" busy>
        body
      </Dialog>,
    );
    const backdrop = document.querySelector('.st-dialog-backdrop')!;
    await user.pointer({ target: backdrop, keys: '[MouseLeft]' });
    expect(onClose).not.toHaveBeenCalled();
    rerender(
      <Dialog open onClose={onClose} title="T">
        body
      </Dialog>,
    );
    await user.pointer({
      target: document.querySelector('.st-dialog-backdrop')!,
      keys: '[MouseLeft]',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Tabs', () => {
  it('supports roving tabindex with arrow, Home and End keys', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [value, setValue] = useState('a');
      return (
        <>
          <Tabs
            label="Sections"
            idBase="t"
            value={value}
            onChange={setValue}
            items={[
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B', count: 3 },
              { id: 'c', label: 'C' },
            ]}
          />
          <TabPanel base="t" id="a" active={value === 'a'}>
            panel a
          </TabPanel>
          <TabPanel base="t" id="b" active={value === 'b'}>
            panel b
          </TabPanel>
        </>
      );
    }
    render(<Harness />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    tabs[0]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /B/ })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('panel b');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'C' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'C' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'A' })).toHaveFocus();
  });
});

describe('Toast', () => {
  function Trigger() {
    const toast = useToast();
    return (
      <>
        <button
          onClick={() => {
            toast.success('Saved', 'All good');
          }}
        >
          ok
        </button>
        <button
          onClick={() => {
            toast.error('Failed', 'Nope');
          }}
        >
          bad
        </button>
        <button
          onClick={() => {
            toast.info('FYI');
          }}
        >
          info
        </button>
        <button
          onClick={() => {
            toast.warning('Careful');
          }}
        >
          warn
        </button>
      </>
    );
  }
  it('announces confirmations politely and errors assertively, and can be dismissed', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'ok' }));
    const polite = screen.getByRole('status');
    expect(polite).toHaveAttribute('aria-live', 'polite');
    expect(within(polite).getByText('Saved')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'bad' }));
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Failed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'info' }));
    await user.click(screen.getByRole('button', { name: 'warn' }));
    await user.click(within(alert).getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByText('Failed')).toBeNull();
  });

  it('auto-dismisses after a while', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    act(() => {
      screen.getByRole('button', { name: 'ok' }).click();
    });
    expect(screen.getByText('Saved')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(6100);
    });
    expect(screen.queryByText('Saved')).toBeNull();
    vi.useRealTimers();
  });

  it('throws a helpful error outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Trigger />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });
});

describe('Field', () => {
  it('wires label, hint and error to the control', () => {
    render(
      <Field label="Name" hint="Your full name" error="Required">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText('Name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Your full name Required');
  });
});

describe('Badge family: status is never colour alone', () => {
  it('renders an icon and a text label for severity, health, quality and alarm state', () => {
    const { container } = render(
      <>
        <SeverityBadge severity="critical" />
        <HealthBadge health="offline" />
        <QualityBadge quality="stuck" />
        <AlarmStateBadge state="cleared_unacknowledged" />
        <Badge tone="ok">Plain</Badge>
      </>,
    );
    for (const text of ['Critical', 'Offline', 'Stuck', 'Cleared - unacknowledged', 'Plain']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    expect(container.querySelectorAll('.st-badge svg').length).toBe(4);
  });
});

describe('Choice controls', () => {
  it('MultiSelect toggles values and reports pressed state', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <MultiSelect
        label="Severity"
        value={['info']}
        onChange={onChange}
        options={[
          { value: 'info', label: 'Info' },
          { value: 'critical', label: 'Critical' },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Info' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Critical' }));
    expect(onChange).toHaveBeenCalledWith(['info', 'critical']);
    await user.click(screen.getByRole('button', { name: 'Info' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
  it('Segmented selects one value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Segmented
        label="Speed"
        value={1}
        onChange={onChange}
        options={[
          { value: 1, label: '1x' },
          { value: 2, label: '2x' },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: '2x' }));
    expect(onChange).toHaveBeenCalledWith(2);
  });
});

describe('RangeBar', () => {
  it('describes where a value sits against its nominal range', () => {
    const { rerender } = render(<RangeBar value={5} min={0} max={10} unit="bar" />);
    expect(screen.getByRole('img')).toHaveAccessibleName('Within nominal range 0 to 10 bar');
    rerender(<RangeBar value={12} min={0} max={10} unit="bar" />);
    expect(screen.getByRole('img')).toHaveAccessibleName('Above nominal range 0 to 10 bar');
    expect(screen.getByText('above range')).toBeInTheDocument();
    rerender(<RangeBar value={-1} min={0} max={10} unit="bar" />);
    expect(screen.getByText('below range')).toBeInTheDocument();
    rerender(<RangeBar value={null} min={0} max={10} unit="bar" />);
    expect(screen.getByRole('img')).toHaveAccessibleName(/No value/);
    rerender(<RangeBar value={5} min={null} max={null} unit="bar" />);
    expect(screen.getByText('No nominal range')).toBeInTheDocument();
  });
});

describe('DataTable', () => {
  it('renders caption, headers, rows and an empty state', () => {
    const { rerender } = render(
      <DataTable
        caption="People"
        columns={[{ key: 'n', header: 'Name', cell: (r: { n: string }) => r.n }]}
        rows={[{ n: 'Ada' }]}
        getRowKey={(r) => r.n}
      />,
    );
    expect(screen.getByRole('table', { name: 'People' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Ada' })).toHaveAttribute('data-label', 'Name');
    rerender(
      <DataTable
        caption="People"
        columns={[{ key: 'n', header: 'Name', cell: (r: { n: string }) => r.n }]}
        rows={[]}
        getRowKey={(r) => r.n}
        empty={<p>Nobody</p>}
      />,
    );
    expect(screen.getByText('Nobody')).toBeInTheDocument();
  });
});

describe('ErrorBoundary', () => {
  it('contains a rendering failure and allows retry', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    let explode = true;
    function Bomb() {
      if (explode) throw new Error('kaboom');
      return <p>recovered</p>;
    }
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('This page failed to render');
    explode = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
    spy.mockRestore();
  });
});

describe('ThemeToggle', () => {
  it('toggles and persists the explicit theme choice', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole('button', { name: /Switch to (light|dark) theme/ }));
    const chosen = useSettings.getState().theme;
    expect(chosen === 'light' || chosen === 'dark').toBe(true);
    expect(window.localStorage.getItem('seatrace.settings')).toContain(
      `"theme":"${String(chosen)}"`,
    );
  });
});
