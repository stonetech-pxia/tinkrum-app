// 把给别的 AI 用的 App 文件材料放进网站（D-593）：写法说明、动作目录（D-598）、JSON Schema、示例（docs/agent/，由
// packages/planner 的快照测试生成），加上 App 文件检查页用的脚本（和 App 导入时同一套检查，在浏览器里跑），
// 和给 AI 自检用的命令行脚本 tinkrum-check.js（D-594）。
// 用法：node scripts/build-agent-kit.mjs ../tinkrum-site
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = process.argv[2];
if (!site || !existsSync(join(site, 'index.html'))) {
  console.error('usage: node scripts/build-agent-kit.mjs <tinkrum-site folder>');
  process.exit(1);
}
const out = join(site, 'assets', 'agent');
mkdirSync(out, { recursive: true });
for (const file of [
  'tinkrum-app-guide.md',
  'tinkrum-app-actions.md',
  'tinkrum-app.schema.json',
  'example-plants.json',
])
  copyFileSync(join(root, 'docs', 'agent', file), join(out, file));
await build({
  entryPoints: [join(root, 'scripts', 'agent-kit', 'checker-entry.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  outfile: join(out, 'checker.js'),
  logLevel: 'warning',
});
// 给别的 AI 在自己的代码环境里跑的同一套检查（D-594）：一个文件，不依赖别的包。
await build({
  entryPoints: [join(root, 'scripts', 'agent-kit', 'check-cli.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  minify: true,
  legalComments: 'none',
  banner: {
    js: '#!/usr/bin/env node\n// Tinkrum app-file checker: node tinkrum-check.js app.json',
  },
  outfile: join(out, 'tinkrum-check.js'),
  logLevel: 'warning',
});
console.log(`agent kit written to ${out}`);
