// 给别的 AI 自检用的命令行脚本（D-594）：node tinkrum-check.js app.json。和 App 导入、网站检查页是同一套检查
// （checkAppFileText），打包成一个不依赖别的文件的脚本，AI 在自己的代码环境里跑，不联网。
// 输出第一行是 OK / NOT OK，退出码 0 = 能导入，1 = 有问题，2 = 用法不对。
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
  // 设计建议（D-602）：能导入，用起来可以更顺手。照做，除非用户要的就是这样。
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
