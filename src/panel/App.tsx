import { NotebookPicker } from './NotebookPicker';
import { notebookRows, type Notebook } from './notebookTree';
import { TaskFilters } from './TaskFilters';
import { TaskHistory } from './TaskHistory';
import { nextPeriodCandidate, revisedPeriodCandidate } from '../domain/transitions';
import { DateTimeInput } from './DateTimeInput';
import { CalendarDisplayContext, displayDate } from './calendarDisplay';
import { ListSortMenu } from './ListSortMenu';
import { QuickAddTask } from './QuickAddTask';
import { TaskContextMenu } from './TaskContextMenu';
import { Icon } from './Icons';
import { CalendarViewPicker } from './CalendarViewPicker';
import { DateNavigation, TaskList, GroupedList, CalendarDay, CalendarWeek, CalendarMonth, CalendarYear } from './TaskViews';
import { actualCount, projectedCount } from './viewModel';
import { defaultTaskRule, normalizeTaskRule, scheduleDateRuleDefaults } from './taskFormState';
import { SettingsPage } from './SettingsPage';
import React, { useCallback, useEffect, useMemo, useRef, useState, useId } from 'react';
import type { ApplicationCommand, ApplicationSnapshot, SeriesSummary, TaskInput, ViewQuery } from '../services/applicationTypes';
import type { DatedSchedule, Occurrence, PreviewItem, RecurrenceRule, Schedule, SeriesDefinition, Task, ViewKind } from '../shared/models';
import { stableStringify } from '../domain/identity';
import { addDays } from '../domain/dates';
import { lunarToSolar, solarToLunar } from '../adapters/calendar/lunarAdapter';
import { resolveZonedTime, timezoneAdapter } from '../adapters/calendar/timezoneAdapter';
import { createCalendarContext } from '../adapters/calendar';
import { lockPanelScroll } from './scroll';
import { createTranslator, languageDirection, resolveLanguage, systemLocales, translateMessage, type LanguagePreference, type Translator } from '../i18n';
import { TranslationProvider, useTranslation } from '../i18n/react';
import { collapsePanel, listenInvalidation, querySnapshot, requestId, sendCommand, sendTemplateCommand } from './client';

const views: Record<ViewKind, string> = { today: 'view.today', tomorrow: 'view.tomorrow', sevenDays: 'view.sevenDays', inbox: 'view.inbox', all: 'view.all', day: 'view.day', week: 'view.week', month: 'view.month', year: 'view.year' };
const listViews: ViewKind[] = ['today', 'tomorrow', 'sevenDays', 'inbox', 'all'];
const calendarViews: ViewKind[] = ['day', 'week', 'month', 'year'];
const today = () => timezoneAdapter.localDate(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
function monthStart(date: string): string { return date.slice(0, 7) + '-01'; }
export function shiftMonth(date: string, n: number): string { const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1 + n, 1)); return d.toISOString().slice(0, 10); }
function makeSchedule(date: string, time: string, zone: string): Schedule {
  if (!date) return { kind: 'none' };
  if (!time) return { kind: 'allDay', date, zone };
  const resolved = resolveZonedTime(date, time, zone);
  return { kind: 'timed', date, time, zone, instant: resolved.instant, offsetMinutes: resolved.offsetMinutes, adjustment: resolved.adjustment };
}
function describeRule(rule: RecurrenceRule | undefined, t: Translator): string {
  if (!rule) return t('rule.none');
  const unit = t(`rule.unit.${rule.frequency}.${rule.interval === 1 ? 'one' : 'other'}`);
  return t('rule.summary', { calendar: t(`rule.${rule.calendar === 'lunar' ? 'lunar' : 'gregorian'}`), interval: rule.interval, unit }) +
    (rule.weekdays?.length ? t('rule.weekdaysSummary', { days: rule.weekdays.map(day => t(`weekday.${day}`)).join(' / ') }) : '') +
    (rule.basis === 'completed' ? t('rule.completedSummary') : '');
}

type CommandInput = ApplicationCommand extends infer C ? C extends ApplicationCommand ? Omit<C, 'requestId' | 'expectedSnapshotVersion'> : never : never;
// Keep event identities stable while always reading the latest committed UI state.
function useTaskEvent<T extends (...args: any[]) => any>(handler: T): T {
  const ref = useRef(handler);
  React.useLayoutEffect(() => { ref.current = handler; });
  return useCallback(((...args: Parameters<T>) => ref.current(...args)) as T, []);
}
function reuseEqual<T>(previous: T | undefined, next: T): T {
  return previous !== undefined && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}
export function App() {
  const [collapsed, setCollapsed] = useState(false);
  const collapseButton = useRef<HTMLButtonElement>(null);
  const restoreButton = useRef<HTMLButtonElement>(null);
  const wasCollapsed = useRef(false);
  useEffect(() => {
    if (collapsed) restoreButton.current?.focus();
    else if (wasCollapsed.current) collapseButton.current?.focus();
    wasCollapsed.current = collapsed;
  }, [collapsed]);
  const [query, setQuery] = useState<ViewQuery>({ date: today() });
  const [data, setData] = useState<ApplicationSnapshot>();
  const [language, setLanguage] = useState<LanguagePreference>('auto');
  const locale = resolveLanguage(language, data?.systemLocale || systemLocales());
  const t = useMemo(() => createTranslator(locale), [locale]);
  const message = useCallback((value: string, code?: string) => translateMessage(value, locale, code), [locale]);
  useEffect(() => { if (data?.preferences.language) setLanguage(data.preferences.language); }, [data?.preferences.language]);
  useEffect(() => { document.documentElement.lang = locale; document.documentElement.dir = languageDirection(locale); }, [locale]);
  const [errorCode, setErrorCode] = useState<string>();
  const [loadErrorCode, setLoadErrorCode] = useState<string>();
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const pendingCommands = useRef(new Set<string>());
  const commandQueue = useRef<Promise<unknown>>(Promise.resolve());
  const optimisticFields = useRef(new Map<string, { pinned?: boolean; priority?: Task['priority']; completedAt?: number; completed?: boolean }>());
  const dataRef = useRef(data);
  const renderedSnapshot = useRef<ApplicationSnapshot | undefined>(undefined);
  const applyOptimistic = (snapshot: ApplicationSnapshot): ApplicationSnapshot => {
    const previous = renderedSnapshot.current;
    const oldItems = new Map(previous?.items.map(item => [item.id, item]));
    const items = snapshot.items.map(item => {
      const fields = item.kind === 'actual' && !item.historical ? optimisticFields.current.get(item.noteId || '') : undefined;
      return reuseEqual(oldItems.get(item.id), fields ? { ...item, ...fields } : item);
    });
    const next = { ...snapshot,
      tasks: snapshot.tasks.map(task => {
        const fields = !task.historical && optimisticFields.current.get(task.noteId);
        return fields ? { ...task, ...fields } : task;
      }),
      items: previous && items.length === previous.items.length && items.every((item, index) => item === previous.items[index]) ? previous.items : items,
      folders: reuseEqual(previous?.folders, snapshot.folders), tags: reuseEqual(previous?.tags, snapshot.tags),
    };
    renderedSnapshot.current = next;
    return next;
  };
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(false);
  const [menu, setMenu] = useState<{task: Task; tasks: Task[]; x: number; y: number}>();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const closeMenu = useCallback(() => { setMenu(undefined); setSelectedIds(previous => previous.size ? new Set() : previous); }, []);
  useEffect(() => { setSelectedIds(previous => previous.size ? new Set() : previous); setMenu(undefined); }, [query, settings]);
  useEffect(() => {
    if (!data) return;
    const visible = new Set(data.items.filter(item => item.kind === 'actual').map(item => item.occurrenceId || item.noteId));
    setSelectedIds(previous => {
      const next = new Set([...previous].filter(id => visible.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [data]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectedIds(previous => previous.size ? new Set() : previous); };
    const clearOutsideSelection = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('.task-row, .task-menu')) return;
      setSelectedIds(previous => previous.size ? new Set() : previous);
    };
    document.addEventListener('keydown', escape);
    document.addEventListener('click', clearOutsideSelection, true);
    return () => {
      document.removeEventListener('keydown', escape);
      document.removeEventListener('click', clearOutsideSelection, true);
    };
  }, []);

  const [lastListView, setLastListView] = useState<ViewKind>('today');
  const [lastCalendarView, setLastCalendarView] = useState<ViewKind>('day');
  const [navigationHistory, setNavigationHistory] = useState<{view: ViewKind; date: string}[]>([]);
  useEffect(() => {
    if (!data || query.view) return;
    if (calendarViews.includes(data.view)) setLastCalendarView(data.view);
    else setLastListView(data.view);
  }, [data?.view, query.view]);
  const [form, setForm] = useState<'new' | 'edit' | 'series' | 'history' | 'conflict' | null>(null);
  const [selected, setSelected] = useState<Task>();
  const [chosenSeries, setChosenSeries] = useState<SeriesSummary>();
  const [selectedDate, setSelectedDate] = useState(today());
  const refreshSeq = useRef(0);
  const queryRef = useRef(query); queryRef.current = query;
  const refresh = useCallback(async () => {
    const sequence = ++refreshSeq.current;
    try {
      const next = await querySnapshot(queryRef.current);
      if (sequence === refreshSeq.current) { dataRef.current = next; setData(applyOptimistic(next)); setLoadError(''); }
    } catch (e) { if (sequence === refreshSeq.current) { setLoadErrorCode((e as { code?: string }).code); setLoadError(String((e as Error).message)); } }
    finally { if (sequence === refreshSeq.current) setLoading(false); }
  }, []);
  useEffect(() => {
    listenInvalidation(() => { if (!pendingCommands.current.size) void refresh(); }, action => {
      closeMenu();
      if (action.type === 'new') { setSettings(false); setSelected(undefined); setChosenSeries(undefined); setForm('new'); return; }
      void querySnapshot(queryRef.current).then(snapshot => {
        setSettings(false); dataRef.current = snapshot; setData(applyOptimistic(snapshot)); const task = snapshot.tasks.find(t => t.noteId === action.noteId && !t.historical);
        const historical = action.type === 'edit' && !task
          ? snapshot.tasks.find(t => t.noteId === action.noteId && t.historical) : undefined;
        if (task && (action.type === 'edit' || task.seriesId)) {
          setErrorCode(undefined); setError('');
          setSelected(task); setChosenSeries(undefined); setForm(task.seriesId && snapshot.series.some(series => series.seriesId === task.seriesId && series.definition) ? 'series' : 'edit');
        } else if (historical) {
          setErrorCode(undefined); setError('');
          setSelected(historical); setChosenSeries(undefined); setForm('history');
        } else { setErrorCode(undefined); setError(t(action.type === 'edit' ? 'backend.NOT_TODO' : 'error.selectRepeating')); }
      }).catch(e => { setErrorCode(e.code); setError(e.message); });
    }, () => setCollapsed(false));
    void refresh();
  }, [refresh, closeMenu]);
  useEffect(() => { setLoading(true); void refresh(); }, [query, refresh]);
  useEffect(() => {
    if (!form) return;
    setErrorCode(undefined); setError('');
    const previous = document.activeElement as HTMLElement | null;
    const unlockScroll = lockPanelScroll(document.getElementById('root'));
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setForm(null); }
      if (e.key === 'Tab') {
        const nodes = Array.from(document.querySelectorAll<HTMLElement>('.drawer button:not(:disabled),.drawer input:not(:disabled),.drawer textarea,.drawer select:not(:disabled)'));
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    const timer = setTimeout(() => document.querySelector<HTMLElement>('.drawer input,.drawer textarea,.drawer select,.drawer button')?.focus(), 0);
    return () => { clearTimeout(timer); document.removeEventListener('keydown', handler); unlockScroll(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [form]);
  const reloadNative = useCallback(async () => {
    try { await sendCommand({ action: 'refresh', requestId: requestId() }); await refresh(); }
    catch (e) { setErrorCode((e as { code?: string }).code); setError((e as Error).message); }
  }, [refresh]);
  useEffect(() => {
    let active = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resume = () => {
      if (document.hidden || active || pendingCommands.current.size) return;
      active = true;
      const check = async () => {
        try { await sendCommand({ action: 'refresh', requestId: requestId(), checkChanges: true }); await refresh(); }
        catch (e) { setLoadErrorCode((e as { code?: string }).code); setLoadError((e as Error).message); }
        finally { active = false; }
      };
      const next = commandQueue.current.catch(() => undefined).then(check);
      commandQueue.current = next;
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(resume, 150); };
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('focus', schedule);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', schedule); window.removeEventListener('focus', schedule); };
  }, [refresh]);
  const run = async (input: CommandInput, close = false) => {
    const noteId = 'noteId' in input ? input.noteId : undefined;
    const key = noteId || ('seriesId' in input ? input.seriesId : undefined) || 'global';
    if (pendingCommands.current.has(key)) return;
    pendingCommands.current.add(key);
    setPendingIds(new Set(pendingCommands.current));
    if ((input.action === 'complete' || input.action === 'reopen') && input.noteId) {
      const completed = input.action === 'complete';
      optimisticFields.current.set(input.noteId, { completed, completedAt: completed ? Date.now() : 0 });
      setData(previous => previous && applyOptimistic(previous));
    }
    if (input.action === 'setFields') {
      optimisticFields.current.set(input.noteId, { ...(input.pinned !== undefined ? { pinned: input.pinned } : {}), ...(input.priority !== undefined ? { priority: input.priority } : {}) });
      setData(previous => previous && applyOptimistic(previous));
    }
    const execute = async () => {
      setBusy(true); setErrorCode(undefined); setError('');
      try {
        const snapshot = dataRef.current;
        const result = await sendTemplateCommand({ ...input, requestId: requestId(), expectedSnapshotVersion: snapshot?.snapshotVersion } as ApplicationCommand,
          snapshot, queryRef.current, latest => { refreshSeq.current++; dataRef.current = latest; setData(applyOptimistic(latest)); setLoadError(''); });
        if (close) setForm(null);
        return result;
      } catch (e) {
        if (noteId) optimisticFields.current.delete(noteId);
        if (dataRef.current) setData(applyOptimistic(dataRef.current));
        setErrorCode((e as { code?: string }).code); setError((e as Error).message);
      }
      finally {
        if (noteId) optimisticFields.current.delete(noteId);
        await refresh();
        pendingCommands.current.delete(key);
        setPendingIds(new Set(pendingCommands.current));
        setBusy(false);
      }
    };
    const result = commandQueue.current.catch(() => undefined).then(execute);
    commandQueue.current = result;
    return result;
  };
  const runMenuCommands = async (inputs: CommandInput[]) => {
    if (inputs.length === 1) return run(inputs[0]!);
    if (!inputs.length) return;
    const keys = new Set(inputs.map(input => ('noteId' in input && input.noteId) || ('seriesId' in input && input.seriesId) || 'global'));
    if ([...keys].some(key => pendingCommands.current.has(key))) return;
    for (const key of keys) pendingCommands.current.add(key);
    setPendingIds(new Set(pendingCommands.current));
    const execute = async () => {
      setBusy(true); setErrorCode(undefined); setError('');
      let succeeded = 0;
      try {
        let snapshot = await querySnapshot(queryRef.current);
        let result;
        // Delete the anchor last so remaining selections can still write their history.
        // Shared-carrier history must also be removed before deleting the current note.
        const deletionRank = (input: CommandInput) => {
          if (input.action !== 'deleteNativeTask') return 0;
          if (snapshot.series.some(series => series.anchorNoteId === input.noteId)) return input.occurrenceId && snapshot.tasks.some(task => task.occurrenceId === input.occurrenceId && task.historical) ? 2 : 3;
          return snapshot.tasks.some(task => task.occurrenceId === input.occurrenceId && task.historical) ? 0 : 1;
        };
        const ordered = [...inputs].sort((a, b) => deletionRank(a) - deletionRank(b));
        for (const input of ordered) {
          result = await sendTemplateCommand({ ...input, requestId: requestId(), expectedSnapshotVersion: snapshot.snapshotVersion } as ApplicationCommand, snapshot, queryRef.current, latest => { refreshSeq.current++; dataRef.current = latest; setData(applyOptimistic(latest)); });
          succeeded++;
          if ('noteId' in input) setSelectedIds(previous => { const next = new Set(previous); next.delete(('occurrenceId' in input && input.occurrenceId) || input.noteId!); return next; });
          snapshot = await querySnapshot(queryRef.current);
          dataRef.current = snapshot;
        }
        return result;
      } catch (e) { setError(t('menu.batchFailed', { count: succeeded, total: inputs.length }) + ' ' + message((e as Error).message, (e as { code?: string }).code)); }
      finally {
        setSelectedIds(previous => previous.size ? new Set() : previous); await refresh(); setBusy(false);
        for (const key of keys) pendingCommands.current.delete(key);
        setPendingIds(new Set(pendingCommands.current));
      }
    };
    const next = commandQueue.current.catch(() => undefined).then(execute);
    commandQueue.current = next;
    return next;
  };
  const createAndEdit = async (input: TaskInput) => {
    const result = await run({ action: 'createTask', input });
    if (!result?.noteId) return;
    const created: Task = { taskId: result.noteId, noteId: result.noteId, title: input.title, notebookId: input.notebookId,
      tagIds: [], schedule: input.schedule, completedAt: 0, priority: input.priority || 'none', pinned: input.pinned || false,
      reminder: input.reminder || { enabled: false } };
    setSelected(created);
    setForm('edit');
    await run({ action: 'openNote', noteId: result.noteId });
  };
  const visibleError = error || loadError;
  const visibleErrorCode = error ? errorCode : loadErrorCode;
  const view = query.view ?? data?.view ?? 'today';
  const isCalendar = calendarViews.includes(view);
  const date = view === 'today' || view === 'sevenDays' ? today() : view === 'tomorrow' ? addDays(today(), 1) : query.date ?? today();
  const displayCalendar = data?.preferences.displayCalendar ?? 'solar';
  const showCompleted = query.showCompleted ?? data?.preferences.showCompleted ?? false;
  const tasks = useMemo(() => new Map(data?.tasks.filter(t => !t.historical).map(t => [t.noteId, t]) ?? []), [data?.tasks]);
  const series = selected?.seriesId ? data?.series.find(s => s.seriesId === selected.seriesId) : chosenSeries;
  const currentMode = series?.occurrences.find(row => row.occurrenceId === series.activeOccurrenceId)?.mode || series?.definition?.modeForNext;
  const chooseView = (next: ViewKind, targetDate?: string, drillDown = false) => {
    closeMenu();
    if (drillDown) setNavigationHistory(h => [...h, { view, date }]);
    if (listViews.includes(next)) setLastListView(next); else setLastCalendarView(next);
    setQuery(q => ({ ...q, view: next, date: targetDate || q.date || today() }));
    if (targetDate) setSelectedDate(targetDate);
    // Navigation is read-only; persist its preference without disabling task controls.
    void sendCommand({ action: 'savePreferences', requestId: requestId(), preferences: { lastView: next } })
      .catch(e => setError((e as Error).message));
  };
  const openNotebook = useTaskEvent((notebookId: string) => {
    closeMenu();
    setNavigationHistory([]);
    setLastListView('all');
    setQuery(q => ({ ...q, view: 'all', notebookIds: [notebookId], notebookId: undefined, tagId: undefined, search: '' }));
    void sendCommand({ action: 'savePreferences', requestId: requestId(), preferences: { lastView: 'all', notebookIds: [notebookId] } })
      .catch(e => setError((e as Error).message));
  });
  const navigate = (n: number) => {
    const target = view === 'day' ? addDays(date, n) : view === 'week' ? addDays(date, n * 7) : shiftMonth(date, n * (view === 'year' ? 12 : 1));
    setSelectedDate(target); setQuery(q => ({ ...q, date: target }));
  };
  const openItem = useTaskEvent((item: PreviewItem) => {
    setSelectedIds(previous => previous.size ? new Set() : previous);
    if (item.kind === 'projected' || item.historical) { setSelected(undefined); setChosenSeries(data?.series.find(s => s.seriesId === item.seriesId)); setForm('history'); }
    else { setChosenSeries(undefined); setSelected(tasks.get(item.noteId!)); setForm('edit'); }
  });
  const selectableTasks = useMemo(() => new Map(data?.tasks.map(task => [task.occurrenceId || task.noteId, task]) ?? []), [data?.tasks]);
  const openMenu = useTaskEvent((item: PreviewItem, event: React.MouseEvent<HTMLElement>) => {
    const task = selectableTasks.get(item.occurrenceId || item.noteId || '');
    if (!task) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const targets = selectedIds.has(task.occurrenceId || task.noteId) ? [...selectedIds].map(id => selectableTasks.get(id)).filter((value): value is Task => !!value) : [task];
    setSelectedIds(new Set(targets.map(target => target.occurrenceId || target.noteId)));
    setErrorCode(undefined); setError('');
    setMenu({ task, tasks: targets, x: event.clientX || bounds.left, y: event.clientY || bounds.bottom });
  });
  const toggleSelection = useTaskEvent((item: PreviewItem) => {
    if (!item.noteId || pendingIds.has(item.noteId)) return;
    const id = item.occurrenceId || item.noteId;
    setSelectedIds(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; });
  });
  const completeItem = useTaskEvent((item: PreviewItem) => void run({ action: item.completed ? 'reopen' : 'complete', noteId: item.noteId, seriesId: item.seriesId, occurrenceId: item.occurrenceId }));
  const itemList = useCallback((items: PreviewItem[], compact = false, hideDate = false) => <TaskList onOpenNotebook={!isCalendar ? openNotebook : undefined} selectedIds={selectedIds} onToggleSelection={toggleSelection} hideDate={hideDate} items={items} folders={data?.folders} tags={data?.tags} compact={compact} busy={false} pendingIds={pendingIds} onSelect={openItem} onMenu={openMenu} onComplete={completeItem} />, [isCalendar, openNotebook, selectedIds, pendingIds, data?.folders, data?.tags, toggleSelection, openItem, openMenu, completeItem]);
  const formatDate = (value: string) => displayDate(value, displayCalendar, t, new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(value + 'T12:00:00Z')));
  const label = view === 'day' ? formatDate(date) : view === 'week' && data ? `${formatDate(data.range.start)} — ${formatDate(addDays(data.range.end, -1))}` : view === 'month' ? new Intl.DateTimeFormat(locale, {year: 'numeric', month: 'long', timeZone: 'UTC'}).format(new Date(monthStart(date) + 'T12:00:00Z')) : view === 'year' ? date.slice(0, 4) : t(views[view]);

  if (settings && data) return <TranslationProvider locale={locale} timeFormat={data?.preferences.timeFormat}><main className="app" aria-busy={busy}>
    <SettingsPage preferences={data.preferences} busy={busy} error={visibleError} errorCode={visibleErrorCode}
      onCancel={() => { setSettings(false); setErrorCode(undefined); setError(''); }}
      onSave={async preferences => { const result = await run({ action: 'savePreferences', preferences }); if (result) setSettings(false); }}
      onCommand={run} onCleared={() => {
        setSelected(undefined); setChosenSeries(undefined); setForm(null); setMenu(undefined); setSelectedIds(previous => previous.size ? new Set() : previous);
        setNavigationHistory([]); setLastListView('inbox'); setQuery({ view: 'inbox', date: today() });
      }} />
  </main></TranslationProvider>;

  return <TranslationProvider locale={locale} timeFormat={data?.preferences.timeFormat}><CalendarDisplayContext.Provider value={displayCalendar}><div className="panel-window">{collapsed && <button ref={restoreButton} className="panel-restore" aria-label={t('panel.restore')} title={t('panel.restore')} onClick={() => setCollapsed(false)}><Icon name="restore" /></button>}<main hidden={collapsed} className="app" aria-busy={busy || loading}>
    <header className="app-header"><div className="header-start"><div className="window-actions"><button ref={collapseButton} title={t('panel.collapse')} aria-label={t('panel.collapse')} aria-expanded={true} onClick={() => { closeMenu(); void collapsePanel().then(compact => { if (!compact) setCollapsed(true); }).catch(e => { setErrorCode(e.code); setError(e.message); }); }}><Icon name="collapse" /></button></div><div className="mode-switch" role="group" aria-label={t('view.label')}><button className={!isCalendar ? 'active' : ''} aria-pressed={!isCalendar} aria-label={t('mode.list')} title={t('mode.list')} onClick={() => chooseView(lastListView)}><Icon name="list" size={24} /></button><button className={isCalendar ? 'active' : ''} aria-pressed={isCalendar} aria-label={t('mode.calendar')} title={t('mode.calendar')} onClick={() => chooseView(lastCalendarView)}><Icon name="calendar" size={24} /></button></div></div><h1 className="journey-brand">JOURNEY TASKS</h1><div className="header-actions"><button onClick={() => void reloadNative()} disabled={busy} title={t('actions.refresh')} aria-label={t('actions.refresh')}><Icon name="refresh" /></button><button disabled={busy || !data} onClick={() => { closeMenu(); setForm(null); setErrorCode(undefined); setError(''); setSettings(true); }} aria-label={t('actions.settings')}><Icon name="settings" /></button><button className="primary new-task" aria-label={t('actions.newTask')} title={t('actions.newTask')} onClick={() => { setSelected(undefined); setChosenSeries(undefined); setForm('new'); }}><Icon name="plus" size={18} /></button></div></header>
    {!isCalendar ? <nav className="tabs smart-lists" aria-label={t('mode.list')}>{listViews.map(key => <button key={key} aria-pressed={view === key} className={view === key ? 'active' : ''} onClick={() => chooseView(key)}><Icon name={key === 'inbox' ? 'inbox' : key === 'all' ? 'list' : key === 'today' ? 'today' : key === 'tomorrow' ? 'tomorrow' : 'sevenDays'} size={17} />{t(views[key])}</button>)}</nav> : <div className="calendar-toolbar">{!!navigationHistory.length && <button className="back-view" aria-label={t('navigation.back')} onClick={() => { const back = navigationHistory[navigationHistory.length - 1]!; setNavigationHistory(h => h.slice(0, -1)); setQuery(q => ({...q, view: back.view, date: back.date})); setSelectedDate(back.date); }}><Icon name="back" /></button>}<DateNavigation view={view} label={label} onNavigate={navigate} onToday={() => { setSelectedDate(today()); setQuery(q => ({ ...q, date: today() })); }} viewSelector={<CalendarViewPicker view={view} onChange={next => chooseView(next, selectedDate)} />} /></div>}
    {data && <QuickAddTask folders={data.folders} preferences={data.preferences} busy={busy} today={today()} onPreferences={preferences => run({ action: 'savePreferences', preferences })} onCreate={input => run({ action: 'createTask', input })} />}
    <div className="view-options"><TaskFilters controls={<><span className="options-label"><Icon name="options" size={17} />{t('list.options')}</span><label><input type="checkbox" checked={showCompleted} onChange={e => {const value = e.target.checked; setQuery(q => ({...q, showCompleted: value})); void run({action: 'savePreferences', preferences: {showCompleted: value}});}} />{t('list.showCompleted')}</label><label>{t('calendar.display')}<select disabled={busy || !data} value={displayCalendar} onChange={e => void run({ action: 'savePreferences', preferences: { displayCalendar: e.target.value as 'solar' | 'lunar' } })}><option value="solar">{t('rule.gregorian')}</option><option value="lunar">{t('rule.lunar')}</option></select></label></>} folders={data?.folders ?? []} selected={query.notebookIds ?? data?.preferences.notebookIds ?? []} busy={busy || !data} search={query.search ?? ''} onSearch={search => setQuery(q => ({ ...q, search }))} onChange={notebookIds => { setQuery(q => ({ ...q, notebookIds })); void run({ action: 'savePreferences', preferences: { notebookIds } }); }}>{!isCalendar && <ListSortMenu grouping={data?.preferences.listGrouping ?? 'time'} direction={data?.preferences.listSort ?? 'scheduledAsc'} busy={busy || !data} onChange={preferences => void run({ action: 'savePreferences', preferences })} />}{isCalendar && data && <div className="calendar-summary"><Icon name="statistics" size={17} /><span className="task-total">{t('list.actualCount', { count: actualCount(data.items) })}</span>{projectedCount(data.items) > 0 && <span>, {t('list.projectedCount', { count: projectedCount(data.items) })}</span>}</div>}</TaskFilters></div>


    {visibleError && <div className="error" role="alert">{message(visibleError, visibleErrorCode)}<button onClick={() => void refresh()}>{t('actions.retry')}</button></div>}
    {loading && !data && <p className="empty" role="status">{t('list.loading')}</p>}
    {data?.diagnostics.filter((d, index, all) => d.code === 'LEGACY_DATA_IGNORED' ? all.findIndex(item => item.code === d.code) === index : !d.seriesId || all.findIndex(item => item.code === d.code && item.seriesId === d.seriesId) === index).map((d, i) => <div className="warning" key={`${d.code}:${i}`}>{message(d.message, d.code)}{d.seriesId && data.series.some(series => series.seriesId === d.seriesId && series.definition && series.conflicts.length > 0) && <button onClick={() => { setSelected(undefined); setChosenSeries(data.series.find(s => s.seriesId === d.seriesId)); setForm('conflict'); }}>{t('list.viewSeries')}</button>}</div>)}
    {data?.warnings.filter(w => !data.diagnostics.some(d => d.message === w)).map((w, i) => <p className="warning" key={i}>{message(w)}</p>)}
    {data && !data.items.length && ((query.search ?? '').trim() || (query.notebookIds ?? data.preferences.notebookIds ?? []).length > 0) && <div className="filter-empty"><p>{t('filter.empty')}</p><button disabled={busy} onClick={() => { setQuery(q => ({ ...q, search: '', notebookIds: [] })); void run({ action: 'savePreferences', preferences: { notebookIds: [] } }); }}>{t('filter.clearAll')}</button></div>}
    {data && <div className="view-surface">{(view === 'day' ? <CalendarDay selectedIds={selectedIds} items={data.items} renderList={items => itemList(items, false, true)} /> : view === 'week' ? <CalendarWeek date={date} items={data.items} onSelect={d => chooseView('day', d, true)} renderList={items => itemList(items, true)} /> : view === 'month' ? <CalendarMonth date={date} items={data.items} selectedDate={selectedDate} onSelect={d => chooseView('day', d, true)} onWeek={d => chooseView('week', d, true)} renderList={items => itemList(items, true)} /> : view === 'year' ? <CalendarYear date={date} items={data.items} selectedDate={selectedDate} onSelect={d => chooseView('day', d, true)} onWeek={d => chooseView('week', d, true)} onMonth={d => chooseView('month', d, true)} /> : <GroupedList items={data.items} folders={data.folders} grouping={data.preferences.listGrouping} direction={data.preferences.listSort} renderList={items => itemList(items)} />)}</div>}
    {data && !data.items.length && !visibleError && <section className="empty"><span className="empty-icon">✓</span><h2>{t('list.emptyTitle')}</h2><p>{t('list.emptyHint')}</p><button onClick={() => { setSelected(undefined); setForm('new'); }}>{t('form.new')}</button></section>}
    {data?.truncated && <p className="warning">{t('list.truncated')}</p>}
    {menu && data && <TaskContextMenu series={data.series} task={menu.task} tasks={menu.tasks} x={menu.x} y={menu.y} folders={data.folders} onCommand={runMenuCommands} busy={menu.tasks.some(task => pendingIds.has(task.noteId))} onClose={closeMenu} onHistory={() => { setChosenSeries(undefined); setSelected(menu.task); closeMenu(); setForm('history'); }} error={visibleError} errorCode={visibleErrorCode} />}
    {form && data && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setForm(null); }}><section className="drawer" role="dialog" aria-modal="true" aria-label={t('form.edit')}><header className="drawer-header"><h2>{({ new: t('form.new'), edit: t('form.edit'), series: t('form.series'), history: t('form.history'), conflict: t('form.conflict') })[form]}</h2><button aria-label={t('actions.close')} onClick={() => setForm(null)}>✕</button></header>{visibleError && form !== 'new' && form !== 'edit' && <div className="error" role="alert">{message(visibleError, visibleErrorCode)}</div>}
      {form === 'new' && <TaskForm folders={data.folders} busy={busy} submitError={visibleError} submitErrorCode={visibleErrorCode} defaultCalendar={data.preferences.defaultCalendar} initialDate={view === 'inbox' ? '' : date} onSubmit={input => void createAndEdit(input)} />}
      {form === 'edit' && selected && <><TaskForm folders={data.folders} task={selected} onInsertTemplate={() => void run({ action: 'insertTemplateBlock', noteId: selected.noteId })} busy={busy} submitError={visibleError} submitErrorCode={visibleErrorCode} initialDate={date} onSubmit={input => void run({ action: 'editTask', noteId: selected.noteId, patch: { title: input.title, notebookId: input.notebookId, reminder: input.reminder, ...(!selected.seriesId ? { schedule: input.schedule, recurrence: input.recurrence, mode: input.mode } : {}) } }, true)} />
        <div className="action-grid"><button onClick={() => void run({ action: 'openNote', noteId: selected.noteId })}>{t('actions.openOriginal').replace(/\s+↗$/, '\u00a0↗')}</button><button onClick={() => void run({ action: 'snooze', noteId: selected.noteId, until: Date.now() + 10 * 60_000 }, true)}>{t('actions.snoozeTen')}</button><button onClick={() => setForm('history')}>{t('actions.history')}</button>{selected.seriesId && <>{series?.definition && <button onClick={() => setForm('series')}>{t('actions.editSeries')}</button>}<button onClick={() => { if (confirm(t('confirm.skip'))) void run({ action: 'abandonTask', noteId: selected.noteId }, true); }}>{t('menu.abandon')}</button>{series?.definition?.modeForNext === 'archive' && <button onClick={() => void run({ action: 'openNote', noteId: series.anchorNoteId || series.controlNoteId }, true)}>{t('actions.openTemplateSource')}</button>}</>}
        <button className="danger" onClick={() => { if (confirm(t(currentMode === 'continuous' ? 'confirm.deleteCurrentContinuous' : 'confirm.deleteCurrentArchive'))) void run({ action: 'deleteNativeTask', noteId: selected.noteId }, true); }}>{t('actions.deleteCurrent')}</button>{series?.definition && series.status !== 'ended' && <button className="danger" onClick={() => { if (confirm(t('confirm.endRepeat'))) void run({ action: 'deleteTask', noteId: selected.noteId, seriesId: selected.seriesId, scope: 'stop' }, true); }}>{t('actions.endRepeat')}</button>}</div></>}
      {form === 'series' && series?.definition && <><button className="danger" disabled={busy} onClick={() => { if (confirm(t('confirm.deleteSeries'))) void run({ action: 'deleteTask', noteId: series.anchorNoteId || series.controlNoteId, seriesId: series.seriesId, scope: 'history' }, true); }}>{t('actions.deleteSeries')}</button><SeriesEditor history={series.occurrences.filter(o => !o.withdrawn && (o.consumed || o.resolution !== 'open')).sort((a, b) => a.carrierGeneration - b.carrierGeneration)} resumeUnavailable={series.resumeUnavailable} ended={series.status === 'ended'} folders={data.folders} onInsertTemplate={() => void run({ action: 'insertTemplateBlock', noteId: series.anchorNoteId || series.controlNoteId })} definition={series.definition} consumedCount={series.consumedCount} currentDisplaySchedule={series.occurrences.find(o => o.occurrenceId === series.activeOccurrenceId)?.deferred} currentSchedule={series.occurrences.find(o => o.occurrenceId === series.activeOccurrenceId)?.scheduled} busy={busy} onStop={() => { if (confirm(t('confirm.endRepeat'))) void run({ action: 'deleteTask', noteId: series.anchorNoteId || series.controlNoteId, seriesId: series.seriesId, scope: 'stop' }, true); }} onSave={(definition, currentSchedule, moveSeries) => { void run({ action: 'reviseSeries', seriesId: definition.seriesId, revisionId: definition.revisionId, definition, currentSchedule, moveSeries }, true); }} /></>}
      {form === 'history' && <TaskHistory occurrences={series?.occurrences} entries={data.taskLogs?.[series?.seriesId || selected?.noteId || ''] || []} folders={data.folders} title={series?.title || selected?.title || ''} busy={busy}
        onComplete={series ? occurrence => void run({ action: 'complete', seriesId: series.seriesId, occurrenceId: occurrence.occurrenceId }) : undefined}
        onReopen={series ? occurrence => void run({ action: 'reopen', seriesId: series.seriesId, occurrenceId: occurrence.occurrenceId }) : undefined}
        onOpen={occurrence => void run({ action: 'openNote', noteId: occurrence.carrierNoteId })} />}
      {form === 'conflict' && series && <><p>{series.warning ? message(series.warning, series.warningCode) : t('series.recoveryHint')}</p>{series.conflicts.map((c, i) => <p className="warning" key={i}>{message(c.message, c.code)}</p>)}{series.revisionChoices.map((choice, i) => <article className="card" key={choice.revisionId}><h3>{t('series.branch', { number: i + 1 })}</h3><p>{describeRule(choice.rule, t)} · {choice.anchor.date} · {choice.anchor.zone} · {choice.modeForNext === 'archive' ? t('field.archive') : t('field.continuous')}</p><button disabled={busy || series.revisionIds.length < 2} onClick={() => { if (confirm(t('confirm.resolve'))) void run({ action: 'resolveConflict', seriesId: series.seriesId, definition: choice, revisionIds: series.revisionIds }, true); }}>{t('actions.keepBranch')}</button></article>)}{series.advanceChoices?.map(choice => <article className="card advance-choice" key={choice.opId}><p>{t('series.advanceChoice', { date: choice.date || t('field.endsAfterCurrent') })}</p>{choice.noteId && <button onClick={() => void run({ action: 'openNote', noteId: choice.noteId })}>{choice.title} · {t('actions.openNote')}</button>}<button disabled={busy || series.revisionIds.length > 1} onClick={() => { if (confirm(t('confirm.keepOccurrence'))) void run({ action: 'keepOccurrence', seriesId: series.seriesId, opId: choice.opId }, true); }}>{t('actions.keepOccurrence')}</button></article>)}<button onClick={() => void refresh()}>{t('actions.reloadSync')}</button></>}
    </section></div>}
  </main></div></CalendarDisplayContext.Provider></TranslationProvider>;
}

interface RuleStateProps { rule: RecurrenceRule; onChange: (r: RecurrenceRule) => void; anchorDate?: string }
function RuleFields({ rule, onChange, anchorDate }: RuleStateProps) {
  const { t, message, locale } = useTranslation();
  const patch = (p: Partial<RecurrenceRule>) => onChange({ ...rule, ...p });
  return <fieldset><legend>{t('rule.title')}</legend><div className="form-grid"><label>{t('rule.calendar')}<select value={rule.calendar} onChange={e => patch({ calendar: e.target.value as 'gregorian' | 'lunar', ...(e.target.value === 'lunar' ? { frequency: 'monthly', monthSelector: 'day', monthDay: Math.min(rule.monthDay ?? 1, 30) } : {}) })}><option value="gregorian">{t('rule.gregorian')}</option><option value="lunar">{t('rule.lunar')}</option></select></label><label>{t('rule.frequency')}<select value={rule.frequency} onChange={e => onChange(scheduleDateRuleDefaults({ ...rule, frequency: e.target.value as RecurrenceRule['frequency'] }, '', anchorDate || today()))}>{(rule.calendar === 'lunar' ? ['monthly', 'yearly'] : ['daily', 'weekly', 'monthly', 'yearly']).map(f => <option value={f} key={f}>{({ daily: t('rule.daily'), weekly: t('rule.weekly'), monthly: t('rule.monthly'), yearly: t('rule.yearly') })[f as RecurrenceRule['frequency']]}</option>)}</select></label><label>{t('rule.interval')}<input type="number" min={1} max={999} required value={rule.interval} onChange={e => patch({ interval: Number(e.target.value) })} /></label><label>{t('rule.basis')}<select value={rule.basis} onChange={e => patch({ basis: e.target.value as RecurrenceRule['basis'] })}><option value="scheduled">{t('rule.scheduled')}</option><option value="completed">{t('rule.completed')}</option></select></label></div>
    {(rule.frequency === 'weekly' || rule.frequency === 'daily') && <div className="weekday-picker"><span className="weekday-options">{Array.from({ length: 7 }, (_, i) => <label key={i}><input type="checkbox" checked={rule.weekdays?.includes(i + 1) ?? false} onChange={e => patch({ weekdays: e.target.checked ? [...rule.weekdays ?? [], i + 1].sort() : rule.weekdays?.filter(x => x !== i + 1) })} />{t(`weekday.${i + 1}`)}</label>)}</span><span className="weekday-actions"><button type="button" onClick={() => patch({ weekdays: [1, 2, 3, 4, 5] })}>{t('rule.workdays')}</button><button type="button" onClick={() => patch({ weekdays: [6, 7] })}>{t('rule.weekend')}</button></span></div>}
    {(rule.frequency === 'monthly' || rule.frequency === 'yearly') && <div className="form-grid"><label>{t('rule.dateMode')}<select value={rule.monthSelector ?? 'day'} onChange={e => patch({ monthSelector: e.target.value as RecurrenceRule['monthSelector'] })}><option value="day">{t('rule.day')}</option><option value="lastDay">{t('rule.lastDay')}</option>{rule.calendar === 'gregorian' && <option value="nthWeekday">{t('rule.nthWeekday')}</option>}{rule.calendar === 'lunar' && rule.frequency === 'yearly' && <option value="lunarYearEnd">{t('rule.lunarYearEnd')}</option>}</select></label>{rule.frequency === 'yearly' && <label>{t('rule.month')}<input type="number" min={1} max={12} value={rule.month ?? 1} onChange={e => patch({ month: Number(e.target.value) })} /></label>}{(rule.monthSelector ?? 'day') === 'day' && <label>{t('field.day')}<input type="number" min={1} max={rule.calendar === 'lunar' ? 30 : 31} value={rule.monthDay ?? 1} onChange={e => patch({ monthDay: Number(e.target.value) })} /></label>}{rule.monthSelector === 'nthWeekday' && <><label>{t('rule.nth')}<input type="number" min={1} max={5} value={rule.nth ?? 1} onChange={e => patch({ nth: Number(e.target.value) })} /></label><label>{t('rule.weekday')}<select value={rule.weekday ?? 1} onChange={e => patch({ weekday: Number(e.target.value) })}>{Array.from({ length: 7 }, (_, i) => <option key={i} value={i + 1}>{t(`weekday.${i + 1}`)}</option>)}</select></label></>}{rule.calendar === 'lunar' && rule.frequency === 'yearly' && <label><input type="checkbox" checked={rule.lunarLeap ?? false} onChange={e => patch({ lunarLeap: e.target.checked })} />{t('rule.leapDate')}</label>}</div>}
    <div className="form-grid"><label>{t('rule.end')}<select value={rule.end.kind} onChange={e => patch({ end: e.target.value === 'until' ? { kind: 'until', date: today() } : e.target.value === 'count' ? { kind: 'count', count: 10 } : { kind: 'never' } })}><option value="never">{t('rule.never')}</option><option value="until">{t('rule.until')}</option><option value="count">{t('rule.count')}</option></select></label>{rule.end.kind === 'until' && <label>{t('rule.untilInclusive')}<DateTimeInput type="date" required value={rule.end.date} onChange={e => patch({ end: { kind: 'until', date: e.target.value } })} /></label>}{rule.end.kind === 'count' && <label>{t('rule.countLabel')}<input type="number" min={1} max={100000} value={rule.end.count} onChange={e => patch({ end: { kind: 'count', count: Number(e.target.value) } })} /></label>}</div><p className="muted">{t('rule.missingDateHint')}</p></fieldset>;
}
export function TaskForm({ folders, task, initialDate, defaultCalendar = 'solar', busy, submitError = '', submitErrorCode, onInsertTemplate, onSubmit }: { folders: Notebook[]; task?: Task; initialDate: string; defaultCalendar?: 'solar' | 'lunar'; busy: boolean; submitError?: string; submitErrorCode?: string; onInsertTemplate?: () => void; onSubmit: (input: TaskInput) => void }) {
  const { t, message, locale } = useTranslation();
  const folderRows = useMemo(() => notebookRows(folders), [folders]);
  const repeatHintId = useId();
  const [title, setTitle] = useState(task?.title ?? '');
  const [date, setDate] = useState(task ? (task.schedule.kind === 'none' ? '' : task.schedule.date) : initialDate);
  const [time, setTime] = useState(task?.schedule.kind === 'timed' ? task.schedule.time.slice(0, 5) : '');
  const [zone] = useState(task?.schedule.kind !== 'none' && task?.schedule.zone || Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [folder, setFolder] = useState(task?.notebookId ?? folderRows[0]?.id ?? '');
  const [reminder, setReminder] = useState(task?.reminderOverride !== undefined ? task.reminderOverride > 0 : task?.reminder.enabled ?? false); const [reminderTime, setReminderTime] = useState(task?.reminder.allDayTime ?? '09:00');
  const [repeating, setRepeating] = useState(false); const [rule, setRule] = useState(() => defaultTaskRule(date)); const [mode, setMode] = useState<'continuous' | 'archive'>('continuous');
  const [calendar, setCalendar] = useState(task ? 'solar' : defaultCalendar); const [lunar, setLunar] = useState(() => { try { return solarToLunar(date); } catch { return { year: 2026, month: 1, day: 1, leap: false }; } });
  const [error, setError] = useState('');
  return <form onInvalidCapture={() => setError(t('error.formInvalid'))} onSubmit={e => { e.preventDefault(); setError(''); try { const schedule = makeSchedule(date, time, zone); if (repeating && schedule.kind === 'none') throw new Error(t('error.repeatDateRequired')); onSubmit({ title, notebookId: folder, schedule, reminder: { enabled: reminder, allDayTime: reminderTime }, ...(task && repeating ? { recurrence: normalizeTaskRule(rule, date), mode } : {}) }); } catch (err) { setError((err as Error).message); } }}>
    <label>{t('field.title')}<input autoFocus required maxLength={1000} value={title} onChange={e => setTitle(e.target.value)} /></label>
    <NotebookPicker label={t('field.notebook')} folders={folders} value={folder} onChange={setFolder} disabled={busy} />
    {!task?.seriesId && <><div className="form-grid"><label>{t('field.inputCalendar')}<select value={calendar} onChange={e => setCalendar(e.target.value as 'solar' | 'lunar')}><option value="solar">{t('rule.gregorian')}</option><option value="lunar">{t('rule.lunar')}</option></select></label><label>{t('field.scheduleDate')}<DateTimeInput type="date" required={repeating} value={date} onChange={e => { const next = e.target.value; setRule(rule => scheduleDateRuleDefaults(rule, date || today(), next)); setDate(next); }} /></label><label>{t('field.optionalTime')}<DateTimeInput type="time" value={time} onChange={e => setTime(e.target.value)} /></label>{date && <label>{t('field.fixedZone')}<input readOnly value={zone} /></label>}</div>{calendar === 'lunar' && <fieldset><legend>{t('field.lunarDate')}</legend><div className="form-grid">{(['year', 'month', 'day'] as const).map((k, i) => <label key={k}>{t(['field.year', 'field.month', 'field.day'][i]!)}<input type="number" min={k === 'year' ? 1901 : 1} max={k === 'year' ? 2099 : k === 'month' ? 12 : 30} value={lunar[k]} onChange={e => setLunar(v => ({ ...v, [k]: Number(e.target.value) }))} /></label>)}</div><label><input type="checkbox" checked={lunar.leap} onChange={e => setLunar(v => ({ ...v, leap: e.target.checked }))} />{t('field.leapMonth')}</label><button type="button" onClick={() => { try { setDate(lunarToSolar(lunar)); setError(''); if (repeating) setRule(r => ({ ...r, calendar: 'lunar', frequency: 'yearly', month: lunar.month, monthDay: lunar.day, lunarLeap: lunar.leap })); } catch (e) { setError((e as Error).message); } }}>{t('field.convertLunar')}</button><p className="muted">{t('field.solarEquivalent', { date })}</p></fieldset>}</>}
    {task?.seriesId && <p className="muted">{t('field.repeatEditHint')}</p>}
    <label className="check"><input type="checkbox" checked={reminder} onChange={e => setReminder(e.target.checked)} />{t('field.nativeReminder')}</label>{reminder && !time && <label>{t('field.allDayReminderTime')}<DateTimeInput type="time" required value={reminderTime} onChange={e => setReminderTime(e.target.value)} /></label>}
    {!task?.seriesId && <><label className="check"><input type="checkbox" disabled={!task || busy} aria-describedby={!task ? repeatHintId : undefined} checked={repeating} onChange={e => { if (!task) return; setRepeating(e.target.checked); if (e.target.checked && calendar === 'lunar') setRule(r => ({ ...r, calendar: 'lunar', frequency: 'yearly', month: lunar.month, monthDay: lunar.day, lunarLeap: lunar.leap })); }} />{t('field.repeating')}</label>{!task && <p id={repeatHintId} className="repeat-hint">{t('field.saveBeforeRepeat')}</p>}{task && repeating && <><RuleFields rule={rule} onChange={setRule} anchorDate={date} /><label>{t('field.mode')}<select value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="continuous">{t('field.continuousDescription')}</option><option value="archive">{t('field.archiveDescription')}</option></select></label><RepeatPreview definition={{ seriesId: 'draft', revisionId: 'draft', parentRevisionIds: [], rule: normalizeTaskRule(rule, date), anchor: { kind: 'allDay', date, zone }, priority: 'none', pinned: false, modeForNext: mode, reminder: { enabled: reminder }, sourceNotebookId: folder, sourceTagIds: [] }} date={date} time={time} currentDate={date} currentTime={time} currentZone={zone} consumedCount={0} /><p className="muted">{t(mode === 'archive' ? 'field.archiveHint' : 'field.continuousHint')}</p>{mode === 'archive' && <button type="button" disabled={busy || !onInsertTemplate} onClick={onInsertTemplate}>{t('actions.insertTemplateBlock')}</button>}</>}</>}
    {(error || submitError) && <p className="error" role="alert">{message(error || submitError, error ? undefined : submitErrorCode)}</p>}<button type="submit" className="primary full" disabled={busy || !folder}>{busy ? t('actions.saving') : t(task ? 'actions.saveTask' : 'actions.saveAndEditNote')}</button>
  </form>;
}
function RepeatPreview({ definition, date, time, currentDate, currentTime, currentZone, consumedCount, regenerate = false, history = [], planned, overrideCurrent = false }: {
  definition: SeriesDefinition; date: string; time: string; currentDate: string; currentTime: string; currentZone: string; consumedCount: number; regenerate?: boolean; planned?: DatedSchedule; overrideCurrent?: boolean; history?: Pick<Occurrence, 'scheduled' | 'resolvedAt'>[];
}) {
  const { t, message } = useTranslation();
  const format = (schedule: DatedSchedule) => `${schedule.date} ${schedule.kind === 'timed' ? schedule.time.slice(0, 5) : t('calendar.allDay')} · ${schedule.zone}`;
  try {
    const anchor = makeSchedule(date, time, definition.anchor.zone);
    let current = makeSchedule(currentDate, currentTime, currentZone);
    if (anchor.kind === 'none' || current.kind === 'none') return <p className="error">{t('error.seriesDateRequired')}</p>;
    if (definition.rule.end.kind === 'count' && definition.rule.end.count <= consumedCount)
      return <p className="warning" role="status">{t('field.seriesCountExhausted')}</p>;
    let basis = planned || current;
    if (regenerate) {
      const calendar = createCalendarContext();
      const candidate = revisedPeriodCandidate({ ...definition, anchor }, history, calendar, consumedCount);
      if (!candidate) return <p className="warning" role="status">{t('backend.SERIES_NO_DATE')}</p>;
      basis = candidate.schedule;
      if (!overrideCurrent) current = candidate.schedule;
    }
    const next = nextPeriodCandidate({ ...definition, anchor }, basis, Date.now(), createCalendarContext(), consumedCount + 1);
    return <div className="card muted"><p>{t('field.currentPreview')}<strong>{format(current)}</strong></p><p>{t('field.nextPreview')}<strong>{next ? format(next.schedule) : t('field.endsAfterCurrent')}</strong></p></div>;
  } catch (error) { return <p className="error">{message((error as Error).message)}</p>; }
}
export function SeriesEditor({ definition, folders = [], consumedCount, currentSchedule, currentDisplaySchedule, history, ended = false, resumeUnavailable = false, busy, onInsertTemplate, onStop, onSave }: { definition: SeriesDefinition; ended?: boolean; resumeUnavailable?: boolean; folders?: Notebook[]; consumedCount: number; currentSchedule?: DatedSchedule; currentDisplaySchedule?: DatedSchedule; history?: Pick<Occurrence, 'scheduled' | 'resolvedAt'>[]; busy: boolean; onInsertTemplate: () => void; onStop?: () => void; onSave: (d: SeriesDefinition, s: DatedSchedule | undefined, moveSeries?: boolean) => void }) {
  const { t, message, locale } = useTranslation();
  const [value, setValue] = useState<SeriesDefinition>(() => JSON.parse(JSON.stringify(definition)));
  const [date, setDate] = useState(definition.anchor.date); const [time, setTime] = useState(definition.anchor.kind === 'timed' ? definition.anchor.time.slice(0, 5) : '');
  const [error, setError] = useState('');
  const [moveSeries, setMoveSeries] = useState(false);
  const originalCurrent = currentDisplaySchedule || currentSchedule || definition.anchor;
  const [currentDate, setCurrentDate] = useState(originalCurrent.date);
  const [currentTime, setCurrentTime] = useState(originalCurrent.kind === 'timed' ? originalCurrent.time.slice(0, 5) : '');
  const recurrenceChanged = date !== definition.anchor.date || time !== (definition.anchor.kind === 'timed' ? definition.anchor.time.slice(0, 5) : '') ||
    stableStringify(normalizeTaskRule(value.rule, date)) !== stableStringify(definition.rule);
  const currentChanged = currentDate !== originalCurrent.date || currentTime !== (originalCurrent.kind === 'timed' ? originalCurrent.time.slice(0, 5) : '');
  const requestedCurrent = () => {
    if (!currentSchedule) return undefined;
    const changed = currentDate !== originalCurrent.date || currentTime !== (originalCurrent.kind === 'timed' ? originalCurrent.time.slice(0, 5) : '');
    const schedule = makeSchedule(currentDate, currentTime, originalCurrent.zone);
    if (schedule.kind === 'none') throw new Error(t('error.seriesDateRequired'));
    return changed ? schedule : undefined;
  };

  return <form onSubmit={e => { e.preventDefault(); if (resumeUnavailable) return; try { const schedule = makeSchedule(date, time, definition.anchor.zone); if (schedule.kind === 'none') throw new Error(t('error.seriesDateRequired')); onSave({ ...value, rule: normalizeTaskRule(value.rule, date), anchor: schedule }, requestedCurrent(), moveSeries); } catch (err) { setError((err as Error).message); } }}><p className="muted">{t('field.seriesEditHint')}</p>{resumeUnavailable ? <p className="warning" role="status">{t('backend.SERIES_CURRENT_UNAVAILABLE')}</p> : ended && currentSchedule && <p className="warning" role="status">{t('field.seriesResumeHint')}</p>}<NotebookPicker label={t('field.seriesNotebook')} folders={folders} value={value.sourceNotebookId} disabled={busy} onChange={id => { setValue(v => ({ ...v, sourceNotebookId: id })); setMoveSeries(true); }} /><p className="muted">{t('field.seriesNotebookHint')}</p><div className="form-grid">{currentSchedule && <><label>{t('field.currentDate')}<DateTimeInput required type="date" value={currentDate} onChange={e => setCurrentDate(e.target.value)} /></label><label>{t('field.optionalClock')}<DateTimeInput type="time" value={currentTime} onChange={e => setCurrentTime(e.target.value)} /></label></>}<label>{t('field.anchorDate')}<DateTimeInput required type="date" value={date} onChange={e => setDate(e.target.value)} /></label><label>{t('field.optionalClock')}<DateTimeInput type="time" value={time} onChange={e => setTime(e.target.value)} /></label></div><label className="check"><input type="checkbox" disabled={busy} checked={value.reminder.enabled} onChange={e => setValue(v => ({ ...v, reminder: { ...v.reminder, enabled: e.target.checked } }))} />{t('field.nativeReminder')}</label>{value.reminder.enabled && !time && <label>{t('field.allDayReminderTime')}<DateTimeInput type="time" required disabled={busy} value={value.reminder.allDayTime || '09:00'} onChange={e => setValue(v => ({ ...v, reminder: { ...v.reminder, allDayTime: e.target.value } }))} /></label>}<p className="muted">{t('field.seriesReminderHint')}</p><RuleFields rule={value.rule} onChange={rule => setValue(v => ({ ...v, rule }))} anchorDate={date} /><label>{t('field.modeNext')}<select value={value.modeForNext} onChange={e => setValue(v => ({ ...v, modeForNext: e.target.value as SeriesDefinition['modeForNext'] }))}><option value="continuous">{t('field.continuous')}</option><option value="archive">{t('field.archive')}</option></select></label><p className="muted">{t(value.modeForNext === 'archive' ? 'field.archiveHint' : 'field.continuousHint')}</p>{value.modeForNext === 'archive' && <button type="button" disabled={busy} onClick={onInsertTemplate}>{t('actions.insertTemplateBlock')}</button>}{(currentSchedule || recurrenceChanged) && <RepeatPreview overrideCurrent={currentChanged} planned={currentSchedule} regenerate={recurrenceChanged} history={history} definition={{ ...value, rule: normalizeTaskRule(value.rule, date) }} date={date} time={time} currentDate={currentDate} currentTime={currentTime} currentZone={originalCurrent.zone} consumedCount={consumedCount} />}{error && <p className="error">{message(error)}</p>}<button className="primary full" disabled={busy || resumeUnavailable}>{t('actions.saveSeries')}</button>{onStop && !ended && <button type="button" className="danger full" disabled={busy} onClick={onStop}>{t('actions.endRepeat')}</button>}</form>;
}
