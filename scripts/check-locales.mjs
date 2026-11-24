import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Missing translations can be listed without blocking during the transition period; remove --allow-missing before officially enabling French.
const allowMissing = process.argv.includes('--allow-missing');
const list = process.argv.includes('--list');
const missing = [];
const errors = [];
let total = 0;
let pairs = 0;
const frenchPairs = new Map();
const pairsSource = ts.createSourceFile(
  'french-pairs.ts',
  fs.readFileSync('packages/core/src/french-pairs.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
function collectPairs(node) {
  if (
    ts.isPropertyAssignment(node) &&
    (ts.isStringLiteralLike(node.name) || ts.isIdentifier(node.name)) &&
    ts.isStringLiteralLike(node.initializer)
  )
    frenchPairs.set(node.name.text, node.initializer.text);
  ts.forEachChild(node, collectPairs);
}
collectPairs(pairsSource);
function filesIn(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (
      ['node_modules', 'dist', 'ios', 'android', '.expo', 'modules', '.claude'].includes(entry.name)
    )
      return [];
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return filesIn(file);
    return /\.(ts|tsx)$/.test(file) && !/(?:test|fixture|eval-cases)/.test(file) ? [file] : [];
  });
}
const placeholders = (value) =>
  [...new Set([...value.matchAll(/\{([a-zA-Z_]\w*)(?::[^}]+)?\}/g)].map((m) => m[1]))]
    .sort()
    .join(',');
for (const file of [...filesIn('packages'), ...filesIn('apps')]) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const props = new Map(
        node.properties
          .filter(ts.isPropertyAssignment)
          .map((p) => [p.name.getText(source).replace(/['"]/g, ''), p.initializer]),
      );
      if (props.has('en') && props.has('zh')) {
        total++;
        const location = `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        const en = props.get('en');
        const fr = props.get('fr');
        if (!fr) missing.push(location);
        else if (ts.isStringLiteralLike(en) && ts.isStringLiteralLike(fr)) {
          if (!fr.text.trim()) errors.push(`${location}: French copy is empty`);
          if (placeholders(en.text) !== placeholders(fr.text))
            errors.push(`${location}: French placeholder mismatch`);
        }
      }
    }
    // Expressions like `zh ? 'Chinese' : 'English'` will display English in the French interface: UI copy must be placed in the message table (except for built-in rules under /ai/, P-037).
    if (
      !file.includes('/ai/') &&
      ts.isConditionalExpression(node) &&
      /\bzh\b|locale === 'zh'|=== 'zh'/.test(node.condition.getText(source)) &&
      [node.whenTrue, node.whenFalse].some(
        (branch) =>
          (ts.isStringLiteralLike(branch) || ts.isTemplateExpression(branch)) &&
          /[\u3400-\u9fff]/.test(branch.getText(source)),
      )
    )
      errors.push(
        `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: zh/en ternary copy displays English in French UI; move it to the message table`,
      );
    if (
      !file.includes('/ai/') &&
      ts.isArrayLiteralExpression(node) &&
      node.elements.length === 2 &&
      node.elements.every(ts.isStringLiteralLike)
    ) {
      const [a, b] = node.elements.map((n) => n.text);
      const isChinese = (s) => /[\u3400-\u9fff]/.test(s);
      const en = isChinese(a) && !isChinese(b) ? b : isChinese(b) && !isChinese(a) ? a : null;
      if (en) {
        pairs++;
        if (!frenchPairs.has(en))
          missing.push(
            `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} (pair: ${en})`,
          );
        else if (placeholders(en) !== placeholders(frenchPairs.get(en)))
          errors.push(`${file}: French placeholder mismatch in name pair`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
// Message table (packages/core/src/messages/): Keys must match exactly across all three languages
// (TypeScript also checks this), French cannot be empty, and placeholders must match English.
const MESSAGES_DIR = 'packages/core/src/messages';
function tables(lang) {
  const file = path.join(MESSAGES_DIR, `${lang}.ts`);
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found = new Map();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      let init = declaration.initializer;
      while (init && (ts.isSatisfiesExpression(init) || ts.isAsExpression(init)))
        init = init.expression;
      if (!init || !ts.isObjectLiteralExpression(init)) continue;
      const entries = new Map();
      for (const p of init.properties)
        if (ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer))
          entries.set(p.name.getText(source).replace(/['"]/g, ''), {
            text: p.initializer.text,
            line: source.getLineAndCharacterOfPosition(p.getStart()).line + 1,
          });
      found.set(declaration.name.getText(source), { file, entries });
    }
  }
  return found;
}
const [enTables, zhTables, frTables] = ['en', 'zh', 'fr'].map(tables);
for (const [enName, otherName, others, lang] of [
  ['en', 'zh', zhTables, 'zh'],
  ['en', 'fr', frTables, 'fr'],
  ['enSingular', 'frSingular', frTables, 'fr'],
]) {
  const base = enTables.get(enName);
  const other = others.get(otherName);
  if (!base || !other) {
    errors.push(`${MESSAGES_DIR}: message table not found (${enName} / ${otherName})`);
    continue;
  }
  for (const [key, { text }] of base.entries) {
    if (lang === 'fr') total++;
    const found = other.entries.get(key);
    if (!found) {
      missing.push(`${other.file} (${otherName}.${key})`);
      continue;
    }
    const location = `${other.file}:${found.line}`;
    if (!found.text.trim())
      errors.push(`${location}: ${lang === 'fr' ? 'French' : 'Chinese'} copy is empty`);
    if (lang === 'fr' && placeholders(text) !== placeholders(found.text))
      errors.push(`${location}: French placeholder mismatch`);
  }
  for (const key of other.entries.keys())
    if (!base.entries.has(key))
      errors.push(`${other.file}: ${otherName}.${key} is missing from English`);
}
console.log(
  `Locale check: ${total} messages, ${pairs} name pairs, ${missing.length} missing French translations.`,
);
if (list) missing.forEach((line) => console.log(`${line}: missing fr`));
errors.forEach((line) => console.error(line));
if (errors.length || (!allowMissing && missing.length)) process.exitCode = 1;
