import { ChoiceGroup, GazeTarget, Icon, ToggleTarget, useSetting, type Choice } from '@forsee/ui';
import { useMemo, useState, type ReactNode } from 'react';
import {
  isVisible,
  resetSettings,
  SettingRow,
  useSettingsCatalogue,
  useSettingsVersion,
  type SettingEntry,
} from './SettingControls';
import type { ForseeRuntime } from './runtime';

/** Categories per page of the index. */
const CATEGORIES_PER_PAGE = 6;
/** Settings per page of a category (each row is a full control). */
const ROWS_PER_PAGE = 3;
/** Index entry for the settings that differ from their defaults. */
const CHANGED = '\u0000changed';

const BUTTON = 'h-full min-h-[3.5rem] w-full px-3 text-[clamp(1rem,2.4vh,1.35rem)]';
const SECTION = 'flex h-full min-h-0 flex-col gap-[clamp(0.75rem,2.5vh,1.5rem)]';
const NOTE = 'text-[clamp(0.9rem,2.2vh,1.15rem)] text-ink-muted';

/**
 * Settings → All settings: generated from the registered schemas. An
 * index of categories (plus "Changed from default"), each opening a paged
 * list of controls. Advanced and therapist settings appear only with
 * "Show advanced settings" on.
 */
export function AllSettingsSection({ runtime }: { readonly runtime: ForseeRuntime }): ReactNode {
  const ui = runtime.settings.namespaces.ui;
  const showAdvanced = useSetting(ui, 'showAdvanced') === true;
  const catalogue = useSettingsCatalogue(runtime);
  useSettingsVersion(runtime);
  const [open, setOpen] = useState<string | null>(null);

  const visible = useMemo(
    () => catalogue.filter((e) => isVisible(e.field, showAdvanced)),
    [catalogue, showAdvanced],
  );
  const changed = visible.filter((e) => {
    try {
      return runtime.kernel.settings.isModified(e.namespace, e.field.key);
    } catch {
      return false;
    }
  });

  if (open !== null) {
    const entries = open === CHANGED ? changed : visible.filter((e) => e.category === open);
    return (
      <CategoryView
        key={open}
        runtime={runtime}
        title={open === CHANGED ? 'Changed from default' : open}
        entries={entries}
        emptyText={
          open === CHANGED
            ? 'Every setting here is at its default.'
            : 'Nothing to show. Turn on “Show advanced settings” to see more.'
        }
        onBack={() => setOpen(null)}
      />
    );
  }

  // "Changed from default" first: it is where a therapist or a returning user starts.
  const categories: Choice<string>[] = [
    {
      value: CHANGED,
      label: 'Changed from default',
      detail: changed.length === 0 ? 'none' : plural(changed.length, 'setting'),
    },
  ];
  const counts = new Map<string, number>();
  for (const entry of visible) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  for (const [category, count] of counts) {
    categories.push({ value: category, label: category, detail: plural(count, 'setting') });
  }

  return (
    <Index
      runtime={runtime}
      categories={categories}
      showAdvanced={showAdvanced}
      onShowAdvanced={(value) => {
        try {
          runtime.settings.set(ui, 'showAdvanced', value);
        } catch (error) {
          runtime.reportError(error, 'app.settings.showAdvanced');
        }
      }}
      onOpen={setOpen}
    />
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function Index({
  categories,
  showAdvanced,
  onShowAdvanced,
  onOpen,
}: {
  readonly runtime: ForseeRuntime;
  readonly categories: readonly Choice<string>[];
  readonly showAdvanced: boolean;
  readonly onShowAdvanced: (value: boolean) => void;
  readonly onOpen: (category: string) => void;
}): ReactNode {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(categories.length / CATEGORIES_PER_PAGE));
  const current = Math.min(page, pages - 1);
  const shown = categories.slice(
    current * CATEGORIES_PER_PAGE,
    (current + 1) * CATEGORIES_PER_PAGE,
  );
  return (
    <div className={SECTION}>
      <div className="grid min-h-[4rem] grid-cols-[minmax(0,1fr)_clamp(10rem,26vw,18rem)] items-center gap-[clamp(0.75rem,2vh,1.25rem)]">
        <p className={NOTE}>
          Changes apply at once. Changes that could make Forsee hard to use ask “Keep these
          settings?” and are undone unless you select Keep.
        </p>
        <ToggleTarget
          id="settings/all/show-advanced"
          label="Show advanced"
          value={showAdvanced}
          onChange={onShowAdvanced}
        />
      </div>
      <ChoiceGroup
        label={pages > 1 ? `Categories (page ${current + 1} of ${pages})` : 'Categories'}
        idPrefix="settings/all/category"
        choices={shown}
        value={undefined}
        onChoose={onOpen}
        columns={2}
        checkMark={false}
        className="min-h-0 flex-1"
      />
      {pages > 1 && (
        <Pager
          idPrefix="settings/all/categories-page"
          page={current}
          pages={pages}
          onPage={setPage}
        />
      )}
    </div>
  );
}

function CategoryView({
  runtime,
  title,
  entries,
  emptyText,
  onBack,
}: {
  readonly runtime: ForseeRuntime;
  readonly title: string;
  readonly entries: readonly SettingEntry[];
  readonly emptyText: string;
  readonly onBack: () => void;
}): ReactNode {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(entries.length / ROWS_PER_PAGE));
  const current = Math.min(page, pages - 1);
  const shown = entries.slice(current * ROWS_PER_PAGE, (current + 1) * ROWS_PER_PAGE);
  const anyModified = entries.some((e) => {
    try {
      return runtime.kernel.settings.isModified(e.namespace, e.field.key);
    } catch {
      return false;
    }
  });
  return (
    <div className={SECTION}>
      <div className="grid min-h-[3.5rem] grid-cols-[clamp(8rem,20vw,13rem)_minmax(0,1fr)_clamp(8rem,20vw,13rem)] items-center gap-[clamp(0.75rem,2vh,1.25rem)]">
        <GazeTarget
          id="settings/all/back"
          dwellClass="function"
          label="Back to categories"
          appearance="neutral"
          onActivate={onBack}
          className={BUTTON}
        >
          <Icon name="back" size={26} />
          <span>Back</span>
        </GazeTarget>
        <h3 className="truncate text-center text-[clamp(1.05rem,2.8vh,1.5rem)] font-semibold">
          {pages > 1 ? `${title} (page ${current + 1} of ${pages})` : title}
        </h3>
        <GazeTarget
          id="settings/all/reset-category"
          dwellClass="destructive"
          label={`Reset all of ${title}`}
          appearance="neutral"
          disabled={!anyModified}
          onActivate={() => resetSettings(runtime, entries)}
          className={BUTTON}
        >
          <span>Reset all</span>
        </GazeTarget>
      </div>
      {entries.length === 0 ? (
        <p className={NOTE}>{emptyText}</p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-[clamp(0.75rem,2vh,1.25rem)]">
          {shown.map((entry) => (
            <SettingRow
              key={`${entry.namespace}/${entry.field.key}`}
              runtime={runtime}
              entry={entry}
            />
          ))}
        </ul>
      )}
      {pages > 1 && (
        <Pager idPrefix="settings/all/page" page={current} pages={pages} onPage={setPage} />
      )}
    </div>
  );
}

function Pager({
  idPrefix,
  page,
  pages,
  onPage,
}: {
  readonly idPrefix: string;
  readonly page: number;
  readonly pages: number;
  readonly onPage: (page: number) => void;
}): ReactNode {
  return (
    <div className="grid min-h-[3.5rem] grid-cols-2 gap-[clamp(0.75rem,2vh,1.25rem)]">
      <GazeTarget
        id={`${idPrefix}/previous`}
        dwellClass="function"
        label="Previous page"
        appearance="neutral"
        disabled={page === 0}
        onActivate={() => onPage(Math.max(0, page - 1))}
        className={BUTTON}
      >
        <Icon name="previous" size={26} />
        <span>Previous</span>
      </GazeTarget>
      <GazeTarget
        id={`${idPrefix}/next`}
        dwellClass="function"
        label="Next page"
        appearance="neutral"
        disabled={page >= pages - 1}
        onActivate={() => onPage(Math.min(pages - 1, page + 1))}
        className={BUTTON}
      >
        <Icon name="next" size={26} />
        <span>More</span>
      </GazeTarget>
    </div>
  );
}
