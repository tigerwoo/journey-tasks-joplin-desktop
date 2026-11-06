import { notebookRows, type Notebook } from './notebookTree';
import type { DateOnly, PreviewItem } from '../shared/models';
import { addDays, dateString, epochDay, isoWeekday, parseDate, viewRange } from '../domain/dates';

export type ListGrouping = 'time' | 'notebook';
export type ListOrder = 'ascending' | 'descending';
export interface ListGroup { id: string; kind: 'pinned' | 'overdue' | 'date' | 'inbox' | 'notebook'; date?: DateOnly; title?: string; items: PreviewItem[] }
/** Filtering belongs to domain projection; grouping is exclusive and never duplicates an ID. */
export function groupListItems(items: readonly PreviewItem[], grouping: ListGrouping = 'time', direction: ListOrder | import('../adapters/joplin/localIntentStore').ListSort = 'scheduledAsc', folders: readonly Notebook[] = [], locale = 'en'): ListGroup[] {
  const rows = notebookRows(folders);
  const names = new Map(rows.map(folder => [folder.id, folder.title]));
  const notebookOrder = new Map(rows.map((folder, index) => [`notebook:${folder.id}`, index]));
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const sort = direction === 'ascending' ? 'scheduledAsc' : direction === 'descending' ? 'scheduledDesc' : direction;
  const sign = sort.endsWith('Desc') ? -1 : 1;
  const created = (a: PreviewItem, b: PreviewItem, order: number) =>
    Number(!a.createdAt) - Number(!b.createdAt) || (a.createdAt && b.createdAt ? order * (a.createdAt - b.createdAt) : 0);
  const compare = (a: PreviewItem, b: PreviewItem) => {
    let primary = 0;
    if (sort.startsWith('name')) primary = sign * collator.compare(a.title, b.title);
    else if (sort.startsWith('created')) primary = created(a, b, sign);
    else {
      primary = Number(a.schedule.kind === 'none') - Number(b.schedule.kind === 'none');
      if (!primary && a.schedule.kind !== 'none' && b.schedule.kind !== 'none') {
        primary = sign * a.date.localeCompare(b.date) || Number(a.schedule.kind === 'timed') - Number(b.schedule.kind === 'timed') ||
          (a.schedule.kind === 'timed' && b.schedule.kind === 'timed' ? sign * (a.schedule.instant - b.schedule.instant) : 0);
      }
    }
    return primary || created(a, b, -1) || a.id.localeCompare(b.id);
  };
  const groups = new Map<string, ListGroup>(), seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const kind = item.pinned && !item.completed ? 'pinned' : grouping === 'notebook' ? 'notebook' : item.overdue && !item.completed ? 'overdue' : item.schedule.kind === 'none' ? 'inbox' : 'date';
    const id = kind === 'date' ? item.date : kind === 'notebook' ? `notebook:${item.notebookId}` : kind;
    let group = groups.get(id);
    if (!group) { group = {id, kind, ...(kind === 'notebook' ? { title: names.get(item.notebookId ?? '') ?? item.notebookId ?? '' } : {}), ...(kind === 'date' ? {date: item.date} : {}), items: []}; groups.set(id, group); }
    group.items.push(item);
  }
  const rank = (group: ListGroup) => group.kind === 'pinned' ? 0 : group.kind === 'overdue' ? 1 : group.kind === 'date' ? 2 : 3;
  for (const group of groups.values()) group.items.sort(compare);
  return [...groups.values()].sort((a,b) => rank(a) - rank(b) || (grouping === 'notebook'
    ? (notebookOrder.get(a.id) ?? rows.length) - (notebookOrder.get(b.id) ?? rows.length) || a.id.localeCompare(b.id)
    : (sort === 'scheduledDesc' ? -1 : 1) * a.id.localeCompare(b.id)));
}
export function isoWeekNumber(date: DateOnly): number {
  const thursday = addDays(date, 4 - isoWeekday(date));
  const year = parseDate(thursday).year;
  const january4 = dateString(year, 1, 4);
  const firstThursday = addDays(january4, 4 - isoWeekday(january4));
  return 1 + Math.round((epochDay(thursday) - epochDay(firstThursday)) / 7);
}
export interface CalendarWeek { start: DateOnly; end: DateOnly; weekNumber: number; dates: DateOnly[] }
/** Sunday-first display rows are labelled by their Thursday's ISO week. */
export function calendarWeeks(date: DateOnly): CalendarWeek[] {
  const range = viewRange('month', date), weeks: CalendarWeek[] = [];
  for (let start = range.start; start < range.end; start = addDays(start, 7)) weeks.push({start, end: addDays(start, 7), weekNumber: isoWeekNumber(addDays(start, 4)), dates: Array.from({length: 7}, (_, i) => addDays(start, i))});
  return weeks;
}
export function actualCount(items: readonly PreviewItem[]): number { return new Set(items.filter(item => item.kind === 'actual').map(item => item.occurrenceId ?? item.noteId ?? item.id)).size; }
export function projectedCount(items: readonly PreviewItem[]): number { return new Set(items.filter(item => item.kind === 'projected').map(item => item.id)).size; }

// Logical civil-time positions define gaps; rendered groups may grow to fit all tasks.
export const DAY_TIMELINE_HEIGHT = 768;
export function dayTimelineGroups(items: readonly PreviewItem[]) {
  const rows = items.filter(item => item.schedule.kind === 'timed').map(item => {
    const instant = item.schedule.kind === 'timed' ? item.schedule.instant : 0;
    const date = new Date(instant);
    const minute = date.getHours() * 60 + date.getMinutes();
    return { item, top: Math.min(DAY_TIMELINE_HEIGHT - 40, minute / 1440 * DAY_TIMELINE_HEIGHT) };
  }).sort((a, b) => a.top - b.top || (a.item.schedule.kind === 'timed' && b.item.schedule.kind === 'timed' ? a.item.schedule.instant - b.item.schedule.instant : 0));
  const groups: { top: number; height: number; items: PreviewItem[] }[] = [];
  for (const row of rows) {
    const previous = groups[groups.length - 1];
    if (previous && row.top < previous.top + previous.height) {
      previous.height = (row.top - previous.top) + 40;
      previous.items.push(row.item);
    } else groups.push({top: row.top, height: 40, items: [row.item]});
  }
  return groups;
}
