// A CLI script for other AIs to perform self-checks (D-594): node tinkrum-check.js app.json. Uses
// the same check suite as app import and website check pages (checkAppFileText), packaged into a
// self-contained dependency-free script for AIs to run in their code environment without network
// access. The first line of output is OK / NOT OK, exit code 0 = importable, 1 = has issues, 2 =
// incorrect usage.
import { readFileSync } from 'node:fs';

import {
  BUILTIN_TOOLS,
  appFileJsonText,
  chatAppLink,
  checkHandoffFileText,
  createRegistry,
} from '@morph/core';

const USAGE = 'usage: node tinkrum-check.js <app-file.json>   (or - to read from stdin)';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function main(): number {
  const path = process.argv[2];
  if (!path) {
    console.error(USAGE);
    return 2;
  }
  let text: string;
  try {
    text = readFileSync(path === '-' ? 0 : path, 'utf8');
  } catch (e) {
    console.error(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const check = checkHandoffFileText(text, {
    registry: createRegistry(BUILTIN_TOOLS),
    locale: 'en',
    now: new Date(),
  });
  if (!check.ok) {
    console.log(
      'NOT OK: Tinkrum cannot import this app file. Fix these problems and run the check again:',
    );
    for (const p of check.problems) console.log(`- ${p}`);
    return 1;
  }
  const s = check.summary;
  const what = [
    plural(s.pages, 'page', 'pages'),
    plural(s.tables, 'table', 'tables'),
    plural(s.quickActions, 'quick action', 'quick actions'),
    plural(s.reminders, 'reminder', 'reminders'),
  ].join(', ');
  console.log(`OK: "${s.name}" can be imported (${what}).`);
  if (check.warnings.length > 0) {
    console.log('It imports, but these parts will not work yet; fix them too:');
    for (const w of check.warnings) console.log(`- ${w}`);
  }
  // Design hints (D-602): importable, but can be made smoother to use. Follow these unless the user explicitly requested otherwise.
  if (check.hints.length > 0) {
    console.log(
      'Suggestions to make the app easier to use; apply them unless the person asked for it this way:',
    );
    for (const h of check.hints) console.log(`- ${h}`);
  }
  const link = chatAppLink(appFileJsonText(text));
  if (link) console.log(`Open in Tinkrum: ${link}`);
  else
    console.log(
      'No Open in Tinkrum link: the file is too long for one. Give only the JSON code block.',
    );
  return 0;
}

process.exitCode = main();
