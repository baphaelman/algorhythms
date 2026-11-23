/** The Export dialog's shared controls: segmented radios and switches (PLAN.md §12 Controls). */

import type { ReactNode } from 'react';

/** A group of radio buttons drawn as a segmented control (the Generate panel's look). */
export function Radios<T extends string | number>({
  legend,
  name,
  value,
  options,
  disabled,
  testId,
  hint,
  isDisabled,
  className,
  onChange,
}: {
  legend: string;
  /** Extra class on the segments. */
  className?: string;
  /** A tooltip on the group. */
  hint?: string;
  /** Options that can't be chosen (skipped by the arrow keys). */
  isDisabled?: (v: T) => boolean;
  name: string;
  value: T;
  options: readonly { id: T; label: string }[];
  disabled?: boolean;
  testId: string;
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="field" disabled={disabled} title={hint}>
      <legend>{legend}</legend>
      <div className={className ? `seg radios ${className}` : 'seg radios'} data-testid={testId}>
        {options.map((o) => (
          <label key={o.id} className={value === o.id ? 'on' : undefined}>
            <input
              type="radio"
              name={name}
              value={String(o.id)}
              checked={value === o.id}
              disabled={isDisabled?.(o.id)}
              onChange={() => onChange(o.id)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A yes/no choice as a switch (checkbox role="switch": Space toggles, aria-checked), label left. */
export function Switch({
  checked,
  disabled,
  testId,
  label,
  className,
  hint,
  onChange,
  children,
}: {
  checked: boolean;
  /** A tooltip. */
  hint?: string;
  disabled?: boolean;
  testId: string;
  label: string;
  className?: string;
  onChange: (v: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <label className={className ? `look-switch ${className}` : 'look-switch'} title={hint}>
      <span className="switch-text">
        <span>{label}</span>
        {children}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
