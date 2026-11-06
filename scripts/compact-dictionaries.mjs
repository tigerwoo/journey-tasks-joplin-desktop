// Locale keys are stored once per bundle; each locale carries only its translated values.
// Host translation calls use literal keys (including direct dictionary lookups).
import { readFile, readdir } from 'node:fs/promises';

export async function dictionaries(keys) {
  const counts = new Map();
  for (const file of (await readdir('src/i18n/locales')).filter(file => file.endsWith('.json')).sort()) {
    const dictionary = JSON.parse(await readFile('src/i18n/locales/' + file, 'utf8'));
    for (const [key, value] of Object.entries(dictionary)) {
      if ((!keys || keys.has(key)) && value.length > 12) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  // Pool long values, then front-code their common prefixes. Recovery messages share
  // phrases within each language as well as whole strings across regional variants.
  const pool = [...counts.keys()].sort();
  const suffixOrder = [];
  const encoded = pool.map((value, index) => {
    const previous = pool[index - 1] ?? '';
    let prefix = 0;
    while (prefix < value.length && prefix < previous.length && value[prefix] === previous[prefix]) prefix++;
    let packed = value;
    let bytes = Buffer.byteLength(JSON.stringify(value));
    const consider = candidate => {
      const size = Buffer.byteLength(JSON.stringify(candidate));
      if (size < bytes) { packed = candidate; bytes = size; }
    };
    consider([prefix, value.slice(prefix)]);
    // Neighbours in reversed-string order find repeated endings without a large suffix table.
    const reversed = value.split('').reverse().join('');
    let left = 0, right = suffixOrder.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (suffixOrder[middle].reversed < reversed) left = middle + 1; else right = middle;
    }
    const candidates = [index - 1, suffixOrder[left - 1]?.index, suffixOrder[left]?.index];
    for (const base of candidates) {
      if (base === undefined || base < 0) continue;
      const reference = pool[base];
      let start = 0, end = 0;
      while (start < value.length && start < reference.length && value[start] === reference[start]) start++;
      while (end < value.length - start && end < reference.length - start &&
        value[value.length - 1 - end] === reference[reference.length - 1 - end]) end++;
      consider([base, start, end, value.slice(start, value.length - end)]);
    }
    suffixOrder.splice(left, 0, { reversed, index });
    return packed;
  });
  const indices = new Map(pool.map((value, index) => [value, index]));
  return { name: 'compact-dictionaries', setup(builder) {
    builder.onResolve({ filter: /^journey-locale-pool$/ }, args => ({ path: args.path, namespace: 'locale-pool' }));
    builder.onLoad({ filter: /.*/, namespace: 'locale-pool' }, () => ({ contents: `const encoded = ${JSON.stringify(encoded)}; const pool = [];
      for (const value of encoded) pool.push(typeof value === 'string' ? value : value.length === 2 ? pool[pool.length - 1].slice(0, value[0]) + value[1] : pool[value[0]].slice(0, value[1]) + value[3] + (value[2] ? pool[value[0]].slice(-value[2]) : ''));
      export default pool;`, loader: 'js' }));
    builder.onResolve({ filter: /^journey-locale-keys:/ }, args => ({ path: args.path, namespace: 'locale-keys' }));
    builder.onLoad({ filter: /.*/, namespace: 'locale-keys' }, args => ({ contents: `export default ${args.path.slice('journey-locale-keys:'.length)}`, loader: 'js' }));
    builder.onLoad({ filter: /[/\\]i18n[/\\]locales[/\\].*\.json$/ }, async args => {
      const dictionary = JSON.parse(await readFile(args.path, 'utf8'));
      const names = Object.keys(dictionary).filter(key => !keys || keys.has(key)).sort();
      const signature = JSON.stringify(names);
      return { contents: `import keys from ${JSON.stringify('journey-locale-keys:' + signature)};
        import pool from 'journey-locale-pool';
        const values = ${JSON.stringify(names.map(key => indices.get(dictionary[key]) ?? dictionary[key]))};
        export default Object.fromEntries(keys.map((key, index) => [key, typeof values[index] === 'number' ? pool[values[index]] : values[index]]));`, loader: 'js' };
    });
  } };
}
