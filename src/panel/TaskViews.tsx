import { notebookRows } from './notebookTree';
import React, { memo, useEffect, useMemo, useState } from 'react';
import type { PreviewItem, ViewKind } from '../shared/models';
import { addDays } from '../domain/dates';
import { timezoneAdapter } from '../adapters/calendar/timezoneAdapter';
import { displayDate, lunarText, useDisplayCalendar } from './calendarDisplay';
import { type ListGrouping, type ListOrder, calendarWeeks, groupListItems, dayTimelineGroups, DAY_TIMELINE_HEIGHT } from './viewModel';
import { useTranslation } from '../i18n/react';
import { Icon } from './Icons';

type Named = { id: string; title: string; parent_id?: string };
type MenuEvent = React.MouseEvent<HTMLElement>;
const today = () => timezoneAdapter.localDate(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
export interface TaskListProps {
  items: PreviewItem[]; busy: boolean; onSelect: (item: PreviewItem, event?: MenuEvent) => void; onComplete: (item: PreviewItem) => void;
  onOpenNotebook?: (notebookId: string) => void;
  pendingIds?: ReadonlySet<string>; selectedIds?: ReadonlySet<string>; onToggleSelection?: (item: PreviewItem) => void; folders?: Named[]; tags?: Named[]; onMenu?: (item: PreviewItem, event: MenuEvent) => void; compact?: boolean; hideDate?: boolean;
}
export function TaskList({ items, busy, onSelect, onComplete, folders = [], tags = [], onMenu, compact = false, hideDate = false, pendingIds, selectedIds, onToggleSelection, onOpenNotebook }: TaskListProps) {
  const { locale } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const upcoming = items.filter(item => !item.completed && item.reminderAt && item.reminderAt > Date.now()).map(item => item.reminderAt!);
    if (!upcoming.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, Math.max(0, Math.min(...upcoming) - Date.now())));
    // Node-based renderers should not stay alive solely for a future UI update.
    if (typeof timer === 'object') timer.unref();
    return () => clearTimeout(timer);
  }, [items, now]);
  const folderMap = useMemo(() => new Map(folders.map(folder => [folder.id, folder])), [folders]);
  const tagMap = useMemo(() => new Map(tags.map(tag => [tag.id, tag])), [tags]);
  const todayDate = today();
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', timeZone: 'UTC' }), [locale]);
  const yearFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }), [locale]);
  // Only reminder transitions and local date changes need to invalidate every row.
  return <div className={`task-list ${compact ? 'mini-tasks' : ''}`}>{items.map(item => <TaskRow key={item.id}
    item={item} busy={busy} onSelect={onSelect} onComplete={onComplete} onMenu={onMenu} onToggleSelection={onToggleSelection} onOpenNotebook={onOpenNotebook}
    compact={compact} hideDate={hideDate} folderMap={folderMap} tagMap={tagMap} dateFormatter={dateFormatter} yearFormatter={yearFormatter}
    todayDate={todayDate} currentTime={now}
    selected={!!selectedIds?.has(item.occurrenceId || item.noteId || '')} hasSelection={!!selectedIds} pending={!!pendingIds?.has(item.noteId || '')} />)}</div>;
}
const TaskRow = memo(function TaskRow({ item, busy, onSelect, onComplete, onMenu, onToggleSelection, onOpenNotebook, compact, hideDate,
  selected, pending, hasSelection, folderMap, tagMap, currentTime, todayDate, dateFormatter, yearFormatter }: Omit<TaskListProps, 'items' | 'folders' | 'tags' | 'selectedIds' | 'pendingIds'> & {
  item: PreviewItem; selected: boolean; pending: boolean; hasSelection: boolean; folderMap: Map<string, Named>; tagMap: Map<string, Named>;
  currentTime: number; todayDate: string; dateFormatter: Intl.DateTimeFormat; yearFormatter: Intl.DateTimeFormat;
}) {
  currentTime = Math.max(currentTime, Date.now());
  const { t, message, formatTime } = useTranslation();
  const calendar = useDisplayCalendar();
  const leadingRepeat = compact || hideDate;
  const repeatMark = <span className="repeat-mark" role="img" aria-label={t('calendar.repeat')} title={t('calendar.repeat')}><Icon name="repeat" size={16} /></span>;
  return <article
    onClickCapture={e => {
      const mac = /Mac|iPhone|iPad/.test(navigator.platform);
      if (item.kind === 'actual' && onToggleSelection && (mac ? e.metaKey : e.ctrlKey)) {
        e.preventDefault(); e.stopPropagation(); onToggleSelection(item);
      }
    }}
    data-selected={item.kind === 'actual' && selected || undefined}
    onContextMenu={e => { if (item.kind === 'actual' && onMenu) { e.preventDefault(); onMenu(item, e); } }}
    className={`task-row ${item.kind === 'projected' ? 'projected' : ''} ${item.overdue ? 'overdue' : ''} ${item.completed ? 'completed' : ''}`}>
    {item.kind === 'actual' ? <input type="checkbox" aria-label={t(item.completed ? 'actions.reopenTask' : 'actions.completeTask', { title: item.title })}
      checked={item.completed} disabled={busy || pending || (item.historical && !item.seriesId) || (!item.completed && item.schedule.kind !== 'none' && item.schedule.date > timezoneAdapter.localDate(currentTime, item.schedule.zone))} onChange={e => { e.stopPropagation(); onComplete(item); }} /> : <span className="preview-dot" title={[t('calendar.previewHint'), item.assumption ? message(item.assumption) : ''].filter(Boolean).join(' · ')} role="img" aria-label={t('calendar.previewHint')}><Icon name="projected" size={18} /></span>}
    <button className="task-content" aria-pressed={item.kind === 'actual' && hasSelection ? selected : undefined} title={item.title} onClick={e => onSelect(item, e)}><span className="task-heading">{leadingRepeat && item.seriesId && repeatMark}<span className="task-title">{item.title}</span>
      {!!item.reminderAt && <span className={`reminder-mark ${!item.completed && item.reminderAt > currentTime ? 'active' : 'expired'}`} role="img" aria-label={t(!item.completed && item.reminderAt > currentTime ? 'reminder.active' : 'reminder.expired')} title={t(!item.completed && item.reminderAt > currentTime ? 'reminder.active' : 'reminder.expired')}><Icon name="bell" size={16} /></span>}
      {!compact && !!item.tagIds?.length && <span className="task-tags">{item.tagIds.map(id => tagMap.get(id)).filter(Boolean).map(tag => <span className="task-tag" key={tag!.id}>{tag!.title}</span>)}</span>}
    </span></button>
    {!compact && (onOpenNotebook && item.notebookId && folderMap.has(item.notebookId)
      ? <button type="button" className="task-notebook notebook-link" aria-label={`${t('view.all')} · ${t('field.notebook')}: ${folderMap.get(item.notebookId)?.title}`} title={folderMap.get(item.notebookId)?.title} disabled={busy} onClick={event => { event.stopPropagation(); onOpenNotebook(item.notebookId!); }}>{folderMap.get(item.notebookId)?.title}</button>
      : <span className="task-notebook" title={folderMap.get(item.notebookId || '')?.title}>{folderMap.get(item.notebookId || '')?.title}</span>)}
    {!leadingRepeat && item.seriesId && repeatMark}
    {!compact && !hideDate && <time className="task-date" dateTime={item.date || undefined}>{item.schedule.kind === 'none' ? t('view.inbox') : <>{displayDate(item.date, calendar, t, item.date === todayDate ? t('view.today') : item.date === addDays(todayDate, 1) ? t('view.tomorrow') : (item.date.slice(0, 4) !== todayDate.slice(0, 4) ? yearFormatter : dateFormatter).format(new Date(item.date + 'T12:00:00Z')))}{item.schedule.kind === 'timed' ? ` ${formatTime(item.schedule.instant)}` : ''}</>}</time>}
    {item.kind === 'actual' && onMenu && <button className="more" aria-label={t('menu.task', { title: item.title })} onClick={e => { e.stopPropagation(); onMenu(item, e); }}>⋯</button>}
  </article>;
});

export const GroupedList = memo(function GroupedList({ items, renderList, grouping, direction, folders = [] }: { items: PreviewItem[]; grouping?: ListGrouping; direction?: ListOrder | import('../adapters/joplin/localIntentStore').ListSort; folders?: Named[]; renderList: (items: PreviewItem[]) => React.ReactNode }) {
  const { t, locale } = useTranslation();
  const calendar = useDisplayCalendar();
  const groups = groupListItems(items, grouping, direction, folders, locale);
  const renderGroup = (group: ReturnType<typeof groupListItems>[number], children?: React.ReactNode, path?: string) => <details className="day-group" key={group.id} open>
    <summary className="section-title" title={path}><span className="group-toggle"><Icon name="chevronRight" size={18} /></span><span className="group-heading">{group.kind === 'pinned' ? <Icon name="pin" /> : group.kind === 'overdue' ? <Icon name="clock" /> : <Icon name={group.kind === 'notebook' ? 'folder' : group.kind === 'inbox' ? 'inbox' : 'calendar'} />}
      {group.kind === 'date' ? <>{group.date === today() ? t('view.today') + ' ' : group.date === addDays(today(), 1) ? t('view.tomorrow') + ' ' : ''}{displayDate(group.date!, calendar, t, new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', timeZone: 'UTC' }).format(new Date(group.date! + 'T12:00:00Z')))}</> : group.kind === 'notebook' ? group.title : t(`group.${group.kind}`)}<span className="group-count">{group.items.length}</span></span></summary>
    {!!group.items.length && renderList(group.items)}{children}
  </details>;
  if (grouping !== 'notebook') return <div className="list-surface">{groups.map(group => renderGroup(group))}</div>;
  const rows = notebookRows(folders), byId = new Map(groups.map(group => [group.id, group]));
  const shown = new Set<string>();
  const renderBranch = (index: number): React.ReactNode => {
    const row = rows[index], children: React.ReactNode[] = [];
    for (let next = index + 1; next < rows.length && rows[next].depth > row.depth; next++) {
      if (rows[next].depth === row.depth + 1) children.push(renderBranch(next));
    }
    const group = byId.get(`notebook:${row.id}`);
    if (!group && !children.some(Boolean)) return null;
    shown.add(`notebook:${row.id}`);
    return renderGroup(group ?? { id: `notebook:${row.id}`, kind: 'notebook', title: row.title, items: [] }, children.some(Boolean) ? <div className="notebook-group-children">{children}</div> : undefined, row.path);
  };
  const branches = rows.flatMap((row, index) => row.depth === 0 ? [renderBranch(index)] : []);
  return <div className="list-surface">{groups.filter(group => group.kind === 'pinned').map(group => renderGroup(group))}{branches}{groups.filter(group => group.kind === 'notebook' && !shown.has(group.id)).map(group => renderGroup(group))}</div>;
});

export function CalendarDay({ items, renderList, selectedIds }: { items: PreviewItem[]; selectedIds?: ReadonlySet<string>; renderList: (items: PreviewItem[]) => React.ReactNode }) {
  const { t, formatTime } = useTranslation();
  const allDay = items.filter(i => i.schedule.kind !== 'timed');
  const groups = dayTimelineGroups(items);
  const row = (item: PreviewItem) => <div data-selected={item.kind === 'actual' && selectedIds?.has(item.occurrenceId || item.noteId || '') || undefined} className={`timeline-entry ${item.schedule.kind === 'timed' ? 'timed-entry' : 'all-day'}`} key={item.id}>
    <time className="timeline-time">{item.schedule.kind === 'timed' ? formatTime(item.schedule.instant) : t('calendar.allDay')}</time>
    <span className="timeline-node"><Icon name={item.schedule.kind === 'timed' ? 'clock' : 'today'} size={18} /></span>{renderList([item])}
  </div>;
  const timeAt = (offset: number) => {
    const minutes = Math.round(offset / DAY_TIMELINE_HEIGHT * 1440);
    const clock = new Date(2000, 0, 1, 0, minutes);
    return formatTime(clock);
  };
  const gap = (start: number, end: number) => {
    const height = end - start;
    if (height <= 0) return null;
    if (height < 40) return <div key={`gap-${start}`} style={{height}} />;
    return <details className="timeline-gap" key={`gap-${start}`}>
      <summary><Icon name="chevronRight" size={14} /><span>{t('calendar.freeTime')}</span><time>{timeAt(start)}–{timeAt(end)}</time></summary>
      <div className="timeline-gap-space" style={{height: height - 28}}>
        {Array.from({length: 13}, (_, index) => index * DAY_TIMELINE_HEIGHT / 12)
          .filter(offset => offset >= start + 28 && offset < end)
          .map(offset => <div className="timeline-hour" key={offset} style={{top: offset - start - 28}}><time>{timeAt(offset)}</time></div>)}
      </div>
    </details>;
  };
  return <section className="day-timeline">{allDay.length > 0 && <div className="all-day-tasks">{allDay.map(row)}</div>}
    {groups.length > 0 && <div className="timed-day">
      {groups.map((group, index) => <React.Fragment key={group.items[0]!.id}>
        {gap(index ? groups[index - 1]!.top + groups[index - 1]!.height : 0, group.top)}
        <div className={`timeline-cluster ${group.items.length > 1 ? 'dense' : ''}`} style={{minHeight: group.height}}>{group.items.map(row)}</div>
      </React.Fragment>)}
      {gap(groups[groups.length - 1]!.top + groups[groups.length - 1]!.height, DAY_TIMELINE_HEIGHT)}
    </div>}
  </section>;
}
export interface CalendarProps {
  date: string; items: PreviewItem[]; selectedDate: string; onSelect: (date: string) => void;
  compact?: boolean; onWeek?: (date: string) => void; renderList?: (items: PreviewItem[]) => React.ReactNode;
}
export function CalendarMonth({ date, items, selectedDate, onSelect, onWeek, renderList, compact = false }: CalendarProps) {
  const { t } = useTranslation();
  const calendar = useDisplayCalendar();
  const weeks = calendarWeeks(date), month = date.slice(0, 7);
  return <div className={`calendar ${compact ? 'compact' : 'month-calendar'}`}><div className="weekdays"><span>{t('calendar.weekNumber')}</span>{[7, 1, 2, 3, 4, 5, 6].map(d => <span key={d}>{t(`weekday.${d}`)}</span>)}</div>
    {weeks.map(week => <div className="calendar-week" key={week.start}><button className="week-number" title={t('calendar.openWeek', { date: week.start })} aria-label={t('calendar.weekAccessible', { number: week.weekNumber, date: week.start })} disabled={!onWeek} onClick={() => onWeek?.(week.start)}>{week.weekNumber}</button>
      {week.dates.map(d => { const group = items.filter(i => i.date === d); return <section key={d} className={`calendar-cell ${d.slice(0, 7) !== month ? 'outside' : ''} ${d === selectedDate ? 'selected' : ''} ${d === today() ? 'is-today' : ''} ${group.length ? 'has-tasks' : ''}`}>
        <button className="calendar-day" title={lunarText(d, t)} aria-label={t('calendar.dayAccessible', { date: d, count: group.length })} aria-pressed={d === selectedDate} onClick={() => onSelect(d)}><span className="day-number">{displayDate(d, calendar, t, String(Number(d.slice(8))))}</span>{compact && group.length > 0 && <span className="day-count">{group.length}</span>}</button>
        {!compact && renderList && <MonthTasks key={`${month}:${d}`} items={group} renderList={renderList} />}
      </section>; })}
    </div>)}
  </div>;
}
function MonthTasks({ items, renderList }: { items: PreviewItem[]; renderList: (items: PreviewItem[]) => React.ReactNode }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return <>{renderList(expanded ? items : items.slice(0, 3))}{items.length > 3 && <button
    type="button" className="overflow-count" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
    {t('calendar.taskCount', { count: items.length })} / {t(expanded ? 'calendar.collapseTasks' : 'calendar.expandTasks')}
  </button>}</>;
}
export function CalendarWeek({ date, items, onSelect, renderList }: { date: string; items: PreviewItem[]; onSelect: (d: string) => void; renderList: (items: PreviewItem[]) => React.ReactNode }) {
  const { t } = useTranslation();
  const calendar = useDisplayCalendar();
  const start = addDays(date, -(new Date(date + 'T12:00:00Z').getUTCDay()));
  return <div className="week-scroll"><div className="week-board">{[7, 1, 2, 3, 4, 5, 6].map((weekday, index) => { const d = addDays(start, index); return <section className={`week-column ${d === today() ? 'is-today' : ''}`} key={d}><button className="week-date" onClick={() => onSelect(d)}><span>{t(`weekday.${weekday}`)}</span><strong>{displayDate(d, calendar, t, String(Number(d.slice(8))))}</strong></button>{renderList(items.filter(i => i.date === d))}</section>; })}</div></div>;
}
export function CalendarYear(props: CalendarProps & { onMonth?: (date: string) => void }) {
  const { t } = useTranslation();
  return <div className="year-grid">{Array.from({ length: 12 }, (_, index) => { const date = `${props.date.slice(0, 4)}-${String(index + 1).padStart(2, '0')}-01`; return <section className="year-month" key={date}><button className="month-title" onClick={() => props.onMonth?.(date)}>{t(`month.${index + 1}`)}</button><CalendarMonth {...props} compact date={date} /></section>; })}</div>;
}
export function DateNavigation({ view, label, onNavigate, onToday, viewSelector }: { view: ViewKind; label: string; onNavigate: (direction: number) => void; onToday: () => void; viewSelector?: React.ReactNode }) {
  const { t } = useTranslation();
  const navigable = ['day', 'week', 'month', 'year'].includes(view);
  const unit = view[0]!.toUpperCase() + view.slice(1);
  return <section className="datebar" aria-label={t('navigation.range')}><span className="date-label"><Icon name="calendar" /><strong>{label}</strong></span>{viewSelector}{navigable && <div className="period-navigation"><button aria-label={t(`navigation.previous${unit}`)} onClick={() => onNavigate(-1)}>‹</button><button onClick={onToday}>{t(`navigation.current.${view}`)}</button><button aria-label={t(`navigation.next${unit}`)} onClick={() => onNavigate(1)}>›</button></div>}</section>;
}
