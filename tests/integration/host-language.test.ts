import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskApplication } from '../../src/services/taskApplication';
import { startPlugin } from '../../src/bootstrap';
import { MemoryJoplin } from '../support/memory-joplin';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';

function hostWithLocale(locale: string) {
  const host = new MemoryJoplin() as any;
  host.namespace = DEFAULT_PLUGIN_ID;
  host.settings.globalValues = async (keys: string[]) => keys.map(key => key === 'locale' ? locale : undefined);
  return host;
}

test('auto language receives the Joplin locale without writing any global setting', async () => {
  const host = hostWithLocale('zh_CN');
  const app = new TaskApplication(host); await app.initialize();
  const snapshot = await app.snapshot();
  assert.equal(snapshot.systemLocale, 'zh_CN');
  assert.equal(snapshot.preferences.language, 'auto');
  app.dispose();
});

test('host command labels use the selected language on startup and language does not change command IDs', async () => {
  const host = hostWithLocale('en_US');
  const commands: Array<{ name: string; label: string }> = [];
  host.commands = { execute: async () => {}, register: async (command: any) => { commands.push(command); } };
  host.views = { panels: { create: async () => 'panel', setHtml: async () => {}, addScript: async () => {}, onMessage: async () => {}, postMessage() {}, show: async () => {} } };
  const runtime = await startPlugin(host);
  try {
    assert.equal(commands.length, 14);
    assert.equal(commands.find(c => c.name === 'journey.toggleTasks')?.label, 'Journey: Show/hide tasks');
    assert.equal(commands.find(c => c.name === 'journey.abandonSelected')?.label, 'Journey: Abandon selected task');
    assert.ok(commands.some(c => c.name === 'journey.newTask' && /new task/i.test(c.label)));
    assert.ok(commands.every(c => !/[\u3400-\u9fff]/.test(c.label)));
  } finally { runtime.dispose(); }
});

test('template command wraps selected text through the editor and leaves existing or damaged templates untouched', async () => {
  const host = hostWithLocale('en_US');
  const registered = new Map<string, any>();
  const calls: any[] = [];
  let body = 'Existing execution';
  host.workspace = { selectedNote: async () => ({ id: 'note', body }) };
  host.commands = {
    register: async (command: any) => registered.set(command.name, command),
    execute: async (name: string, ...args: any[]) => { calls.push([name, ...args]); if (name === 'selectedText') return '- [ ] next'; },
  };
  host.views = { panels: { create: async () => 'panel', setHtml: async () => {}, addScript: async () => {}, onMessage: async () => {}, postMessage() {}, show: async () => {} } };
  const runtime = await startPlugin(host);
  try {
    const insert = registered.get('journey.insertTemplateBlock').execute;
    await insert();
    assert.deepEqual(calls, [['selectedText'], ['insertText', '\n<!-- template:start -->\n- [ ] next\n<!-- template:end -->\n']]);
    body += calls[1][1]; calls.length = 0;
    await insert(); assert.deepEqual(calls, []);
    body = '<!-- template:start -->';
    await assert.rejects(insert(), { code: 'TEMPLATE_FORMAT' });
    assert.deepEqual(calls, []);
  } finally { runtime.dispose(); }
});

test('native selected-note completion command targets the current continuous period when history shares its note', async () => {
  const host=hostWithLocale('en_US'),commands:any[]=[];
  host.notebooks.set('book',{id:'book',title:'Book'});
  host.commands={execute:async()=>{},register:async(command:any)=>{commands.push(command);}};
  host.views={panels:{create:async()=>'panel',setHtml:async()=>{},addScript:async()=>{},onMessage:async()=>{},postMessage(){},show:async()=>{}}};
  let noteId='';host.workspace={selectedNote:async()=>({id:noteId})};
  const runtime=await startPlugin(host);
  try {
    const made=await runtime.app.dispatch({action:'createTask',requestId:'current-native',input:{title:'Task',notebookId:'book',schedule:{kind:'allDay',date:'2026-10-01',zone:'Asia/Shanghai'},recurrence:{calendar:'gregorian',frequency:'weekly',interval:1,basis:'scheduled',weekdays:[4],end:{kind:'never'}},mode:'continuous'}});
    noteId=made.noteId!;
    await runtime.app.dispatch({action:'complete',requestId:'first',seriesId:made.seriesId});
    const before=(await runtime.app.snapshot()).series[0]!;
    await commands.find(c=>c.name==='journey.completeSelected').execute();
    const after=(await runtime.app.snapshot()).series[0]!;
    assert.equal(after.consumedCount,before.consumedCount+1);assert.notEqual(after.activeOccurrenceId,before.activeOccurrenceId);
  } finally {runtime.dispose();}
});
