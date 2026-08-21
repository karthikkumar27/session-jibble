import { useEffect, useState } from 'react';
import { Plus, Trash2, Check, AlertCircle } from 'lucide-react';
import {
  Sheet, SheetContent, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import type {
  CategoryConfig, ConfigFieldError, ProjectRow,
} from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: CategoryConfig;
  projects: ProjectRow[];
  onSaved: (config: CategoryConfig) => void;
}

type RuleCategory = 'work' | 'nonWork';
type RuleField = 'roots' | 'contains';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

// Mirrors the backend's ABSOLUTE_RE so the user learns about a bad path on blur
// rather than after a failed round-trip.
const ABSOLUTE_RE = /^(\/|[a-zA-Z]:[\\/]|\\\\|~($|[\\/]))/;

const isValidRoot = (value: string) => ABSOLUTE_RE.test(value.trim());

const clone = (c: CategoryConfig): CategoryConfig => ({
  version: c.version,
  work: { roots: [...c.work.roots], contains: [...c.work.contains] },
  nonWork: { roots: [...c.nonWork.roots], contains: [...c.nonWork.contains] },
});

export function SettingsPanel({ open, onOpenChange, config, projects, onSaved }: Props) {
  const [draft, setDraft] = useState<CategoryConfig>(() => clone(config));
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [serverErrors, setServerErrors] = useState<ConfigFieldError[]>([]);

  // Re-seed the draft each time the panel opens, so a cancelled edit is discarded.
  /* eslint-disable react-hooks/set-state-in-effect -- intentional prop-to-state
     reset: SettingsPanel stays mounted while closed (only the Radix Sheet content
     unmounts), so `draft` must be re-seeded from `config` on every open or a
     cancelled edit would leak into the next one. */
  useEffect(() => {
    if (open) {
      setDraft(clone(config));
      setSaveState('idle');
      setServerErrors([]);
    }
  }, [open, config]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const addEntry = (category: RuleCategory, field: RuleField, value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setDraft(prev => {
      if (prev[category][field].includes(trimmed)) return prev;
      const next = clone(prev);
      next[category][field].push(trimmed);
      return next;
    });
    setSaveState('idle');
  };

  const removeEntry = (category: RuleCategory, field: RuleField, index: number) => {
    setDraft(prev => {
      const next = clone(prev);
      next[category][field].splice(index, 1);
      return next;
    });
    setSaveState('idle');
  };

  const save = async () => {
    setSaveState('saving');
    setServerErrors([]);
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (res.status === 400) {
        const body = await res.json();
        setServerErrors(body.errors ?? []);
        setSaveState('error');
        return;
      }
      if (!res.ok) throw new Error(`Save failed: ${res.status}`);
      const body = await res.json();
      setSaveState('saved');
      onSaved(body.config);
    } catch {
      setServerErrors([{ path: '', message: 'Could not reach the backend on :8089' }]);
      setSaveState('error');
    }
  };

  const uncategorized = projects.filter(p => p.category === 'uncategorized');

  // A name rule matching every known folder is nearly always a typo — most often a
  // fragment that also appears in the home directory, which would sweep everything
  // into one category. Warn rather than block; it is legal, just rarely intended.
  const overBroad =
    projects.length === 0
      ? []
      : (['work', 'nonWork'] as RuleCategory[]).flatMap(category =>
          draft[category].contains.filter(fragment => {
            const frag = fragment.trim().replace(/\\/g, '/').toLowerCase();
            return frag.length > 0 && projects.every(p => p.path.toLowerCase().includes(frag));
          })
        );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <div className="space-y-1.5">
          <SheetTitle>Category settings</SheetTitle>
          <SheetDescription>
            Folders you list here are classified as work or non-work. The most specific
            folder wins, so a personal repo inside a work folder can be listed separately.
          </SheetDescription>
        </div>

        <RuleSection
          title="Work folders"
          category="work"
          draft={draft}
          onAdd={addEntry}
          onRemove={removeEntry}
        />
        <RuleSection
          title="Non-work folders"
          category="nonWork"
          draft={draft}
          onAdd={addEntry}
          onRemove={removeEntry}
        />

        {uncategorized.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">
              Uncategorized ({uncategorized.length})
            </h3>
            <p className="text-xs text-muted-foreground">
              No rule matches these folders yet. Assign the ones that matter — the rest
              stay uncategorized.
            </p>
            <ul className="space-y-1">
              {uncategorized.slice(0, 25).map(p => (
                <li key={p.path} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 truncate" title={p.path}>{p.displayPath}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {p.hours.toFixed(1)}h
                  </span>
                  <Button variant="outline" size="sm"
                    onClick={() => addEntry('work', 'roots', p.displayPath)}>
                    → Work
                  </Button>
                  <Button variant="outline" size="sm"
                    onClick={() => addEntry('nonWork', 'roots', p.displayPath)}>
                    → Non-work
                  </Button>
                </li>
              ))}
            </ul>
            {uncategorized.length > 25 && (
              <p className="text-xs text-muted-foreground">
                Showing the 25 with the most hours, of {uncategorized.length}.
              </p>
            )}
          </section>
        )}

        {overBroad.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertCircle className="h-4 w-4" />
              Very broad name rule
            </div>
            <p className="mt-1">
              {overBroad.map(f => `"${f}"`).join(', ')} matches every folder in your
              history, so everything will land in one category. Check for a fragment
              that also appears in your home directory path.
            </p>
          </div>
        )}

        {serverErrors.length > 0 && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertCircle className="h-4 w-4" />
              Could not save
            </div>
            <ul className="mt-1 list-disc pl-5">
              {serverErrors.map((e, i) => (
                <li key={i}>{e.path ? `${e.path}: ` : ''}{e.message}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-auto flex items-center gap-3 border-t pt-4">
          <Button onClick={save} disabled={saveState === 'saving'}>
            {saveState === 'saving' ? 'Saving…' : 'Save'}
          </Button>
          {saveState === 'saved' && (
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <Check className="h-4 w-4" /> Saved
            </span>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

interface RuleSectionProps {
  title: string;
  category: RuleCategory;
  draft: CategoryConfig;
  onAdd: (category: RuleCategory, field: RuleField, value: string) => void;
  onRemove: (category: RuleCategory, field: RuleField, index: number) => void;
}

function RuleSection({ title, category, draft, onAdd, onRemove }: RuleSectionProps) {
  const [rootDraft, setRootDraft] = useState('');
  const [rootError, setRootError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');

  const rootInputId = `${category}-root`;
  const nameInputId = `${category}-name`;

  const commitRoot = () => {
    const value = rootDraft.trim();
    if (!value) { setRootError(null); return; }
    if (!isValidRoot(value)) {
      setRootError('Must start with ~ or be an absolute path');
      return;
    }
    setRootError(null);
    onAdd(category, 'roots', value);
    setRootDraft('');
  };

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>

      <ul className="space-y-1">
        {draft[category].roots.map((root, i) => (
          <li key={`${root}-${i}`} className="flex items-center gap-2 text-sm">
            <span className="flex-1 truncate font-mono text-xs" title={root}>{root}</span>
            <Button variant="ghost" size="sm" onClick={() => onRemove(category, 'roots', i)}
              aria-label={`Remove ${root}`}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </li>
        ))}
      </ul>

      <div className="space-y-1">
        <label htmlFor={rootInputId} className="text-xs text-muted-foreground">
          Add a folder
        </label>
        <div className="flex gap-2">
          <input
            id={rootInputId}
            value={rootDraft}
            placeholder="~/gitlab-projects"
            onChange={e => { setRootDraft(e.target.value); setRootError(null); }}
            // Validate on blur, not on submit — the user learns immediately.
            onBlur={commitRoot}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitRoot(); } }}
            className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button variant="outline" size="sm" onClick={commitRoot} aria-label={`Add folder to ${title}`}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        {rootError && (
          <p className="flex items-center gap-1 text-xs text-destructive">
            <AlertCircle className="h-3 w-3" />
            {rootError}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label htmlFor={nameInputId} className="text-xs text-muted-foreground">
          Also match any path containing
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          {draft[category].contains.map((fragment, i) => (
            <span key={`${fragment}-${i}`}
              className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs">
              {fragment}
              <button type="button" onClick={() => onRemove(category, 'contains', i)}
                aria-label={`Remove ${fragment}`}
                className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Trash2 className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
        <input
          id={nameInputId}
          value={nameDraft}
          placeholder="skyiq"
          onChange={e => setNameDraft(e.target.value)}
          onBlur={() => { onAdd(category, 'contains', nameDraft); setNameDraft(''); }}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onAdd(category, 'contains', nameDraft);
              setNameDraft('');
            }
          }}
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
    </section>
  );
}
