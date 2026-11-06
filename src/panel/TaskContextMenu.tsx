import type { Notebook } from './notebookTree';
import { NotebookTree } from './NotebookPicker';
import { DateTimeInput } from './DateTimeInput';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Task } from '../shared/models';
import type { ApplicationCommand, ActionResult, SeriesSummary } from '../services/applicationTypes';
import { addDays } from '../domain/dates';
import { resolveZonedTime, timezoneAdapter } from '../adapters/calendar/timezoneAdapter';
import { useTranslation } from '../i18n/react';
import { Icon } from './Icons';
const timezoneToday = (zone: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now());
type Input = ApplicationCommand extends infer C ? C extends ApplicationCommand ? Omit<C, 'requestId' | 'expectedSnapshotVersion'> : never : never;
export function TaskContextMenu({ task, tasks = [task], x, y, busy, folders, onCommand, onClose, onHistory, error, errorCode, series = [] }: {
  task: Task; tasks?: Task[]; series?: SeriesSummary[]; x: number; y: number; busy: boolean; folders: Notebook[];
  onCommand: (inputs: Input[]) => Promise<ActionResult | undefined>; onClose: () => void; onHistory?: () => void; error?: string; errorCode?: string;
}) {
  const { t, message } = useTranslation();
  const deleteConfirmation = () => [...new Set(tasks.map(target => {
    const summary = series.find(row => row.seriesId === target.seriesId);
    if (!summary || target.historical) return t('menu.confirmDelete');
    const current = summary.occurrences.find(row => row.occurrenceId === summary.activeOccurrenceId);
    return current?.mode === 'continuous' ? t('confirm.deleteCurrentContinuous') : t('confirm.deleteCurrentArchive');
  }))].join('\n\n');
  const [picker, setPicker] = useState<'date' | 'move'>();
  const today = timezoneAdapter.localDate(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [date, setDate] = useState(task.schedule.kind === 'none' ? today : task.schedule.date);
  const [time, setTime] = useState(task.schedule.kind === 'timed' ? task.schedule.time.slice(0, 5) : '');
  const [search, setSearch] = useState('');
  const [submenuPosition, setSubmenuPosition] = useState({ left: 8, top: 8 });
  const submenuRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'Tab') {
        const controls = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select') || []);
        const first = controls[0], last = controls[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handle);
    return () => { document.removeEventListener('keydown', handle); previous?.isConnected && previous.focus({ preventScroll: true }); };
  }, [onClose]);
  useLayoutEffect(() => {
    if (!picker) return;
    const anchor = ref.current?.querySelector(`[data-submenu="${picker}"]`)?.getBoundingClientRect();
    const panel = submenuRef.current;
    if (!anchor || !panel) return;
    const width = panel.getBoundingClientRect().width;
    const height = panel.getBoundingClientRect().height;
    const menu = ref.current!.getBoundingClientRect();
    const right = menu.right + 4;
    setSubmenuPosition({
      left: Math.max(8, right + width <= window.innerWidth - 8 ? right : menu.left - width - 4),
      top: Math.max(8, Math.min(anchor.top, window.innerHeight - height - 8)),
    });
  }, [picker]);
  const closeSubmenu = () => setPicker(current => current === 'move' ? undefined : current);
  const datesLocked = tasks.some(target => target.historical || !!target.completedAt);
  const future = tasks.some(target => target.schedule.kind !== 'none' && target.schedule.date > timezoneToday(target.schedule.zone));
  const allPinned = tasks.every(target => target.pinned);
  const caption = tasks.length > 1 ? t('menu.selectedCount', { count: tasks.length }) : task.title;
  const [failed, setFailed] = useState(false);
  const execute = async (input: Input, preserveTime = true) => {
    const inputs = tasks.map(target => {
      const command = { ...input, noteId: target.noteId } as Input;
      if (command.action === 'deleteNativeTask') command.occurrenceId = target.occurrenceId;
      if (command.action === 'setFields') command.pinned = !allPinned;
      if (command.action === 'changeDate' && 'schedule' in input && input.schedule.kind !== 'none') {
        const date = input.schedule.date;
        const zone = target.schedule.kind === 'none' ? Intl.DateTimeFormat().resolvedOptions().timeZone : target.schedule.zone;
        const selectedTime = preserveTime ? (target.schedule.kind === 'timed' ? target.schedule.time : '') : (input.schedule.kind === 'timed' ? input.schedule.time : '');
        command.schedule = selectedTime ? { kind: 'timed', zone, ...resolveZonedTime(date, selectedTime, zone) } : { kind: 'allDay', date, zone };
      }
      return command;
    });
    const result = await onCommand(inputs);
    if (result?.status === 'saved') onClose();
    else setFailed(true);
  };
  const setDateForTask = (action: 'changeDate', target: string) => {
    if (!target) return;
    const zone = task.schedule.kind === 'none' ? Intl.DateTimeFormat().resolvedOptions().timeZone : task.schedule.zone;
    const schedule = task.schedule.kind === 'timed' ? { ...task.schedule, ...resolveZonedTime(target, task.schedule.time, zone) } : { kind: 'allDay' as const, date: target, zone };
    void execute({ action, noteId: task.noteId, schedule });
  };
  const left = typeof window === 'undefined' ? x : Math.max(8, Math.min(x, window.innerWidth - 300));
  const top = typeof window === 'undefined' ? y : Math.max(8, Math.min(y, window.innerHeight - 430));
  return <><button className="menu-shade" tabIndex={-1} aria-label={t('actions.close')} onClick={onClose} /><div ref={ref} className="task-menu" role="dialog" aria-modal="true" aria-label={t('menu.task', { title: caption })} style={{ left, top }}>
    <div className="menu-caption" onMouseEnter={closeSubmenu}>{caption}</div><div className="menu-date-options" onMouseEnter={closeSubmenu}><span>{t('menu.date')}</span><div>{[0, 1, 7].map(offset => {
      const label = t(offset === 0 ? 'view.today' : offset === 1 ? 'view.tomorrow' : 'menu.nextWeek');
      return <button key={offset} disabled={busy || failed || datesLocked} title={`${addDays(today, offset)} · ${label}`} aria-label={label} onClick={() => setDateForTask('changeDate', addDays(today, offset))}><Icon name={offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : 'sevenDays'} /></button>;
    })}<button disabled={busy || failed || datesLocked} data-submenu="date" aria-haspopup="dialog" title={t('menu.chooseDate')} aria-label={t('menu.chooseDate')} onClick={() => setPicker(picker === 'date' ? undefined : 'date')} aria-expanded={picker === 'date'}><Icon name="calendar" /></button><button disabled={busy || failed || datesLocked} title={t('menu.clearDate')} aria-label={t('menu.clearDate')} onClick={() => void execute({ action: 'changeDate', noteId: task.noteId, schedule: { kind: 'none' } })}><Icon name="clearDate" /></button></div></div>
    <div role="menu" aria-label={t('menu.actions')}>
      {tasks.length === 1 && <button role="menuitem" onMouseEnter={closeSubmenu} disabled={busy || failed} onClick={() => void execute({ action: 'openNote', noteId: task.noteId })}><Icon name="openNote" />{t('actions.openOriginal').replace(/\s+↗$/, '')}</button>}
      {onHistory && tasks.length === 1 && <button role="menuitem" onMouseEnter={closeSubmenu} disabled={busy} onClick={onHistory}><Icon name="list" />{t('actions.history')}</button>}
      <button role="menuitem" onMouseEnter={closeSubmenu} disabled={busy || failed || tasks.some(target => target.historical)} onClick={() => void execute({ action: 'setFields', noteId: task.noteId, pinned: !task.pinned })}><Icon name={allPinned ? 'unpin' : 'pin'} />{t(allPinned ? 'menu.unpin' : 'menu.pin')}</button>
      <button role="menuitem" onMouseEnter={closeSubmenu} disabled={busy || failed || future || tasks.some(target => !!target.completedAt || target.historical)} onClick={() => void execute({ action: 'abandonTask', noteId: task.noteId })}><Icon name="abandon" />{t('menu.abandon')}</button>
      <button role="menuitem" disabled={busy || failed || tasks.some(target => target.historical)} data-submenu="move" aria-haspopup="dialog" aria-expanded={picker === 'move'} onMouseEnter={() => !busy && !failed && !tasks.some(target => target.historical) && setPicker('move')} onClick={() => setPicker('move')}><Icon name="folder" />{t('menu.move')}<span className="menu-chevron">›</span></button>
      <button role="menuitem" onMouseEnter={closeSubmenu} className="danger" disabled={busy || failed} onClick={() => { if (confirm(tasks.length > 1 ? t('menu.confirmDeleteMany', { count: tasks.length }) + '\n\n' + deleteConfirmation() : deleteConfirmation())) void execute({ action: 'deleteNativeTask', noteId: task.noteId }); else onClose(); }}><Icon name="trash" />{t('menu.delete')}</button>
    </div>
    {error && <p className="error" role="alert">{message(error, errorCode)}</p>}
    {picker && <div ref={submenuRef} className="menu-submenu" style={submenuPosition} role="dialog" aria-label={t(picker === 'move' ? 'menu.move' : 'menu.chooseDate')}>
      {picker === 'move' ? <><input type="search" aria-label={t('menu.searchNotebooks')} placeholder={t('menu.searchNotebooks')} value={search} onChange={e => setSearch(e.target.value)} /><div className="menu-folder-list">
        <NotebookTree folders={folders} selected={tasks.every(target => target.notebookId === task.notebookId) ? [task.notebookId ?? ''] : []} search={search} disabled={busy || failed} onSelect={id => void execute({ action: 'moveTask', noteId: task.noteId, notebookId: id })} />
      </div></> : <form onSubmit={e => { e.preventDefault();
        if (!date) return;
        const zone = task.schedule.kind === 'none' ? Intl.DateTimeFormat().resolvedOptions().timeZone : task.schedule.zone;
        const schedule = time ? { kind: 'timed' as const, zone, ...resolveZonedTime(date, time, zone) } : { kind: 'allDay' as const, date, zone };
        void execute({ action: 'changeDate', noteId: task.noteId, schedule }, false); }}>
        <label>{t('menu.chooseDate')}<DateTimeInput required type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        <label>{t('field.time')}<DateTimeInput type="time" value={time} onChange={e => setTime(e.target.value)} /></label><p className="muted">{t(task.seriesId ? 'menu.repeatDateHint' : 'menu.singleDateHint')}</p>
        <button className="primary" disabled={busy || failed}>{t('menu.apply')}</button>
      </form>}
    </div>}
  </div></>;
}
