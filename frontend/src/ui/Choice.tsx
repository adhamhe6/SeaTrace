import { Check } from 'lucide-react';
import type { ReactNode } from 'react';

export interface ChoiceOption<T extends string> {
  value: T;
  label: ReactNode;
}

interface MultiSelectProps<T extends string> {
  label: string;
  options: readonly ChoiceOption<T>[];
  value: readonly T[];
  onChange: (value: T[]) => void;
}

/** Multi-select rendered as a group of toggle buttons (aria-pressed). */
export function MultiSelect<T extends string>({
  label,
  options,
  value,
  onChange,
}: MultiSelectProps<T>) {
  return (
    <div className="st-field">
      <span className="st-field__label" id={`ms-${label.replace(/\s+/g, '-').toLowerCase()}`}>
        {label}
      </span>
      <div className="st-chips" role="group" aria-label={label}>
        {options.map((option) => {
          const on = value.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              className="st-chip"
              aria-pressed={on}
              onClick={() => {
                onChange(on ? value.filter((v) => v !== option.value) : [...value, option.value]);
              }}
            >
              {on ? <Check size={13} aria-hidden="true" /> : null}
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface SegmentedProps<T extends string | number> {
  label: string;
  options: readonly { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}

/** Single-choice segmented control (aria-pressed toggle buttons in a labelled group). */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: SegmentedProps<T>) {
  return (
    <div className="st-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => {
            onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
