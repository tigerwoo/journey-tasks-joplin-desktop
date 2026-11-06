import { NotebookTree } from './NotebookPicker';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { NativeFolder } from '../adapters/joplin/gateway';
import { useTranslation } from '../i18n/react';

export function TaskFilters({ folders, selected, busy, search, onSearch, onChange, controls, children }: {
  controls?: ReactNode; children?: ReactNode;
  folders: NativeFolder[]; selected: string[]; busy: boolean; search: string;
  onSearch: (value: string) => void; onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <>
    <div className="view-option-controls">{controls}
    <div className="notebook-filter" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <button ref={trigger} type="button" aria-expanded={open} aria-label={t('filter.notebooks')} title={selected.length ? t('filter.selected', { count: selected.length }) : t('filter.all')} onClick={() => setOpen(!open)}>
        {selected.length ? t('filter.selected', { count: selected.length }) : t('filter.all')}
      </button>
      {open && <div className="notebook-filter-menu">
        <p>{t('filter.descendants')}</p>
        <div className="filter-actions"><button disabled={busy} onClick={() => onChange(folders.map(folder => folder.id))}>{t('filter.selectAll')}</button><button disabled={busy} onClick={() => onChange([])}>{t('filter.reset')}</button></div>
        <NotebookTree folders={folders} selected={selected} disabled={busy} multiple onSelect={id => onChange(selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id])} />
      </div>}
    </div>
    </div>
    <div className="view-search-controls"><div className="task-search"><input type="search" aria-label={t('filter.search')} placeholder={t('filter.search')} value={search} onChange={event => onSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') onSearch(''); }} />
      {search && <button type="button" aria-label={t('filter.clearSearch')} onClick={() => onSearch('')}>×</button>}
    </div>{children}</div>
  </>;
}
