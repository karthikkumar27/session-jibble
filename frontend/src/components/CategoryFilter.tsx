import { cn } from '@/lib/utils';
import { CATEGORY_LABELS, type CategoryFilterValue } from '@/lib/types';

interface Props {
  value: CategoryFilterValue;
  onChange: (value: CategoryFilterValue) => void;
  uncategorizedCount: number;
}

const BASE_OPTIONS: CategoryFilterValue[] = ['all', 'work', 'nonWork'];

export function CategoryFilter({ value, onChange, uncategorizedCount }: Props) {
  // Uncategorized only appears when it has something in it, so a fully
  // configured team never sees a permanently empty tab.
  const options: CategoryFilterValue[] =
    uncategorizedCount > 0 ? [...BASE_OPTIONS, 'uncategorized'] : BASE_OPTIONS;

  const move = (direction: 1 | -1) => {
    const i = options.indexOf(value);
    const from = i === -1 ? 0 : i;
    onChange(options[(from + direction + options.length) % options.length]);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Filter by category"
      className="inline-flex items-center gap-0.5 rounded-md border bg-muted/40 p-0.5"
      onKeyDown={e => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      }}
    >
      {options.map(option => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            // Roving tabindex: one tab stop for the group, arrows move within it.
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded px-3 py-1 text-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              // Active state carries weight as well as background, so it never
              // depends on colour alone.
              active
                ? 'bg-background font-semibold text-foreground shadow-sm'
                : 'font-normal text-muted-foreground hover:text-foreground'
            )}
          >
            {CATEGORY_LABELS[option]}
            {option === 'uncategorized' && (
              <span className="rounded-full bg-amber-100 px-1.5 text-xs font-medium text-amber-900">
                {uncategorizedCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
