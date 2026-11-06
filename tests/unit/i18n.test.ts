import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createTranslator, languageDirection, isLanguagePreference, registry, resolveLanguage, translateMessage } from '../../src/i18n';
import chinese from '../../src/i18n/locales/zh-CN.json';
import english from '../../src/i18n/locales/en.json';

const placeholders = (text: string) => [...new Set([...text.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]!))].sort();

test('locale registry exposes matching flat JSON dictionaries with readable language names', () => {
  assert.equal(registry['zh-CN'].id, 'zh-CN');
  assert.equal(registry.en.id, 'en');
  assert.ok(registry['zh-CN'].nativeName.trim());
  assert.ok(registry.en.nativeName.trim());
  assert.deepEqual(registry['zh-CN'].dictionary, chinese);
  assert.deepEqual(registry.en.dictionary, english);
  for (const [id, entry] of Object.entries(registry)) {
    assert.equal(entry.id, id);
    assert.ok(entry.nativeName.trim());
    const dictionary: Record<string, string> = entry.dictionary;
    assert.deepEqual(Object.keys(dictionary).sort(), Object.keys(chinese).sort(), id);
    for (const [key, value] of Object.entries(chinese)) {
      const translated = dictionary[key]!;
      assert.equal(typeof translated, 'string', `${id}: ${key}`);
      assert.ok(translated.trim(), `${id}: ${key} cannot be empty`);
      assert.deepEqual(placeholders(value), placeholders(translated), `${id}: ${key} parameters`);
      for (const marker of ['<!-- template:start -->', '<!-- template:end -->', 'template:start/end']) {
        if (value.includes(marker)) assert.ok(translated.includes(marker), `${id}: ${key} template marker`);
      }
      assert.doesNotMatch(translated, /ZXQ|QXZ/, `${id}: ${key} temporary tokens`);
    }
  }
});

test('explicit language preference wins over automatic system locale', () => {
  assert.equal(resolveLanguage('en', 'zh-CN'), 'en');
  assert.equal(resolveLanguage('zh-CN', 'en-US'), 'zh-CN');
  assert.equal(resolveLanguage('en', ['zh-TW', 'en-US']), 'en');
});

test('automatic locale resolves supported regional/script variants and otherwise falls back to US English', () => {
  const cases: Record<string, string> = {
    zh: 'zh-CN', zh_CN: 'zh-CN', 'zh-Hans-TW': 'zh-CN', 'zh-Hans-CN': 'zh-CN',
    'zh-TW': 'zh-TW', 'zh-HK': 'zh-TW', 'zh-MO': 'zh-TW', 'zh-Hant': 'zh-TW', 'zh-Hant-CN': 'zh-TW',
    en: 'en', 'en-US': 'en-US', en_GB: 'en-GB', 'en-AU': 'en',
    'fr-FR': 'fr', 'pt_BR': 'pt-BR', 'ro_MD': 'ro-MD', 'ro': 'ro-RO',
    'fa_IR': 'fa', 'pl-PL': 'pl', 'ja-JP': 'ja', 'ko-KR': 'en-US', '': 'en-US',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(resolveLanguage('auto', input), expected, input);
  for (const id of Object.keys(registry)) {
    assert.equal(resolveLanguage('auto', id), id);
    assert.equal(resolveLanguage(id, 'unsupported'), id);
  }
  assert.equal(resolveLanguage('auto', ['ko-KR', 'fr-FR']), 'fr');
  assert.equal(resolveLanguage('auto', []), 'en-US');
});

test('language preference validation accepts only supported preference identifiers', () => {
  for (const value of ['auto', ...Object.keys(registry)]) assert.equal(isLanguagePreference(value), true);
  for (const value of ['zh', 'ko', 'unsupported', '', null, undefined, 1, ['en'], { locale: 'en' }])
    assert.equal(isLanguagePreference(value), false, JSON.stringify(value));
});

test('translator uses selected dictionary, falls back to Chinese, and leaves unknown user text unchanged', () => {
  const en = createTranslator('en');
  const zh = createTranslator('zh-CN');
  assert.equal(en('view.today'), english['view.today']);
  assert.equal(zh('view.today'), chinese['view.today']);
  assert.equal(createTranslator('unregistered-locale')('view.today'), registry['en-US'].dictionary['view.today']);
  for (const text of ['用户任务：今日与Today', 'My task {{title}}', '<img src=x onerror=alert(1)>'])
    assert.equal(en(text), text, 'a user string is not automatically translated');
  assert.equal(en('__unknown.translation.key__'), '__unknown.translation.key__');
  // A temporarily missing translation must be readable, not undefined or an exception.
  const dictionary = registry.en.dictionary as Record<string, string>;
  const key = 'view.today';
  const previous = dictionary[key];
  try {
    delete dictionary[key];
    assert.equal(en(key), chinese[key]);
  } finally { dictionary[key] = previous!; }
});

test('interpolation preserves missing variables, renders zero, and never recursively processes parameter text', () => {
  const entry = Object.entries(english).find(([, value]) => placeholders(value).length > 0);
  assert.ok(entry, 'dictionary must include an actual parameterized UI message to test');
  const [key, template] = entry;
  const names = placeholders(template);
  const t = createTranslator('en');
  const zero = Object.fromEntries(names.map(name => [name, 0]));
  assert.equal(t(key, zero), template.replace(/\{([^{}]+)\}/g, () => '0'));
  assert.equal(t(key), template, 'missing variables remain visible rather than disappearing');
  const literal = '<b>用户原文</b> {notAnotherLookup} $&';
  const params = Object.fromEntries(names.map(name => [name, literal]));
  assert.equal(t(key, params), template.replace(/\{([^{}]+)\}/g, () => literal));
});

test('diagnostic translation is limited to known messages and preserves unknown details verbatim', () => {
  assert.equal(translateMessage(chinese['error.readTasks'], 'en'), english['error.readTasks']);
  assert.equal(translateMessage(english['error.readTasks'], 'zh-CN'), chinese['error.readTasks']);
  const unknown = 'Unknown backend detail: 用户输入 <b>{title}</b>';
  assert.equal(translateMessage(unknown, 'en', 'NOT_A_REGISTERED_ERROR'), unknown);
});

test('literal translation lookups in panel and bootstrap reference existing dictionary keys', () => {
  for (const filename of ['src/panel/App.tsx', 'src/panel/SettingsPage.tsx', 'src/panel/CleanupSettings.tsx', 'src/panel/TaskViews.tsx', 'src/panel/TaskContextMenu.tsx', 'src/bootstrap.ts']) {
    const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true,
      filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const missing: string[] = [];
    let count = 0;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
        const key = node.arguments[0];
        if (key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))) {
          count++;
          if (!Object.hasOwn(chinese, key.text)) {
            const position = source.getLineAndCharacterOfPosition(key.getStart(source));
            missing.push(`${filename}:${position.line + 1}:${position.character + 1} ${key.text}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.ok(count > 0, `${filename}: the scan must find actual translation calls`);
    assert.deepEqual(missing, [], 'literal translation keys cannot silently render as raw keys');
  }
});

test('only Persian uses right-to-left layout and switching back restores left-to-right', () => {
  for (const id of Object.keys(registry) as Array<keyof typeof registry>) {
    assert.equal(languageDirection(id), id === 'fa' ? 'rtl' : 'ltr');
  }
});

test('Traditional Chinese week terminology is consistent in recurrence and calendar messages', () => {
  const t = createTranslator('zh-TW');
  assert.equal(t('rule.weekly'), '每週');
  assert.equal(t('rule.unit.weekly.one'), '週');
  assert.equal(t('rule.unit.weekly.other'), '週');
  assert.equal(t('rule.weekdaysSummary', { days: '一 / 三' }), ' · 週一 / 三');
  assert.equal(t('calendar.openWeek', { date: '2026-10-25' }), '檢視 2026-10-25 所在週');
  for (const [key, value] of Object.entries(registry['zh-TW'].dictionary)) {
    assert.doesNotMatch(value, /周/, `${key}: temporal terms should use 週`);
  }
});

test('every StorageError and application diagnostic code has a translation in all 26 languages', async () => {
  const { readdirSync } = await import('node:fs');
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(`${dir}/${entry.name}`) : entry.name.endsWith('.ts') ? [`${dir}/${entry.name}`] : []);
  const codes = new Set<string>();
  for (const filename of walk('src')) {
    const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      const storage = ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'StorageError';
      const diagnostic = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'addDiagnostic';
      if (storage || diagnostic) {
        const code = (node as ts.NewExpression | ts.CallExpression).arguments?.[0];
        if (code && ts.isStringLiteralLike(code)) codes.add(code.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const code of ['STALE_SNAPSHOT', 'COMMAND_FAILED', 'CLEANUP_FAILED', 'HOST_API_ERROR', 'SERIES_ADVANCE_PENDING', 'SERIES_RECONCILE', 'SINGLE_RECONCILE']) codes.add(code);
  assert.ok(codes.size > 100, 'scan must inspect actual source errors');
  assert.equal(Object.keys(registry).length, 26);
  for (const [locale, { dictionary }] of Object.entries(registry)) {
    for (const code of codes) assert.ok((dictionary as Record<string, string>)[`backend.${code}`]?.trim(), `${locale}: ${code}`);
  }
});

test('error codes take precedence over backend prose and never append developer details', () => {
  for (const code of ['FUTURE_TASK', 'STALE_SNAPSHOT', 'OUTBOX_CAPACITY', 'SERIES_MOVE_PENDING', 'CLEANUP_INCOMPLETE']) {
    const text = translateMessage('中文开发日志：内部异常', 'en-US', code);
    assert.equal(text, createTranslator('en-US')(`backend.${code}`));
    assert.doesNotMatch(text, /[\u3400-\u9fff]/);
  }
  assert.equal(translateMessage('Waiting for operation secret-id', 'en-US', 'missing-parent'), createTranslator('en-US')('diagnostic.missing-parent'));
});

test('user wording uses abandonment and date changes while legacy log keys remain compatible', () => {
  for (const [locale, { dictionary }] of Object.entries(registry)) {
    for (const [key, value] of Object.entries(dictionary)) {
      assert.doesNotMatch(value, /skip|跳[过過]|延期|postpon/i, `${locale}: ${key}`);
    }
    assert.ok(dictionary['history.skipped']);
    assert.ok(dictionary['history.reopened']);
    assert.equal(Object.hasOwn(dictionary, 'commands.postponeSelected'), false);
  }
  for (const filename of ['README.md', 'README.zh-CN.md']) {
    assert.doesNotMatch(readFileSync(filename, 'utf8'), /\bskip\w*|跳[过過]|延期|postpon/i, filename);
  }
});

test('recovery notices name the affected note in every language without exposing recovery buttons', () => {
  for (const locale of Object.keys(registry)) {
    const t = createTranslator(locale);
    for (const key of ['notice.firstDeleted', 'notice.firstGone', 'notice.completionWaiting', 'notice.completionGone']) {
      const text = t(key, { title: 'Unique task title' });
      assert.ok(text.includes('Unique task title'), `${locale}: ${key}`);
      assert.doesNotMatch(text, /Retry next occurrence|重试生成下一期/, `${locale}: ${key}`);
      assert.doesNotMatch(text, /尚未同步|这个|重新生成|重试生成/);
    }
    assert.doesNotMatch(t('backend.SERIES_NOTEBOOK_MISSING'), /Retry next occurrence|重试生成下一期/, locale);
  }
});
