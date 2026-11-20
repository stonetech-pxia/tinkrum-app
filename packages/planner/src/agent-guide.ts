import {
  AppFileSchema,
  CURRENT_SCHEMA_VERSION,
  MAX_PAGE_BLOCKS,
  MAX_PAGES,
  MAX_TABLES,
  ThemeSchema,
  type Registry,
} from '@morph/core';
import { z } from 'zod';

import type { AgentPattern } from './agent-patterns';
import { buildSystemPrompt } from './prompt';

// 给别的 AI（Claude、ChatGPT……）看的 App 文件写法（D-593）：用户请它们生成一个 tinkrum-app 文件，再从「我的预设」
// 导入。前面是 App 文件自己的规矩（手写），后面的参考从 Tink 的提示词按「## 」标题切出来，外观、字段、动作、风格
// 和 Tink 用的是同一份，登记表一改两边一起变。快照测试把它写进 docs/agent/（vitest -u 更新）。

/**
 * 提示词里的这几段放进参考（标题原样）。Tink 的 Rules 不放（D-598）：大半是对话、草稿和改动步骤的规矩，放进来指南长了
 * 两倍多，测下来别的 AI 第一次就写对的反而少；动作目录和快捷操作预设另放一个文件，要做快捷操作时才读。
 */
const SECTIONS = [
  'Data · containers · tools',
  'Data',
  'Containers',
  'Tools',
  'Theme',
  'Output',
  'Quick-action presets',
  'Built-in tool catalog',
] as const;

function promptSections(registry: Registry): Map<string, string> {
  const [, ...parts] = buildSystemPrompt(registry, 'full').split('\n\n## ');
  const map = new Map<string, string>();
  for (const part of parts) {
    const cut = part.indexOf('\n');
    map.set(part.slice(0, cut), part.slice(cut + 1));
  }
  for (const title of SECTIONS)
    if (!map.has(title)) throw new Error(`prompt section "${title}" is missing`);
  return map;
}

/** Output 一段只留对象的类型（Block、Page、Table…），Plan 和 Op 是 Tink 回话的格式。 */
function objectTypes(output: string): string {
  const from = output.indexOf('type Target');
  const to = output.indexOf('type Plan =');
  if (from < 0 || to < from) throw new Error('prompt Output section changed shape');
  return output.slice(from, to).trimEnd();
}

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
/** 引号里的一段：英文引号、弯引号、直角引号（直角引号可能在英文引号里面，所以最后处理）。 */
const QUOTED = String.raw`(?:"[^"\n]*"|“[^”\n]*”|「[^」\n]*」)`;
const SEP = String.raw`(?:\s*,\s*|\s*\/\s*|\s+or\s+)`;

/**
 * Tink 的提示词里有中文和法语的示例句和名字（用户会这样说），给别的 AI 的说明只要英文（创始人 2026-11-19）：
 * 带中文的引号段连同旁边的分隔符一起去掉（"打开相册" / "Open photo library" → "Open photo library"），
 * 「中文 → 例子」整对去掉，只有中文的括注去掉；去不掉的几处在 ENGLISH 里改写。测试保证结果里没有中文。
 */
function englishOnly(text: string): string {
  const other = (m: string) => CJK.test(m) || frenchQuote(m);
  let out = text;
  for (const { from, to } of ENGLISH) out = out.split(from).join(to);
  return (
    out
      // "合并-日期" → "合并-{date}", 这样的一整对
      .replace(new RegExp(`${QUOTED}\\s*→\\s*${QUOTED}(?:,\\s*)?`, 'g'), (m) =>
        other(m.slice(0, m.indexOf('→'))) ? '' : m,
      )
      .replace(new RegExp(`${SEP}${QUOTED}`, 'g'), (m) => (other(m) ? '' : m))
      .replace(new RegExp(`${QUOTED}${SEP}`, 'g'), (m) => (other(m) ? '' : m))
      .replace(new RegExp(QUOTED, 'g'), (m) => (other(m) ? '' : m))
      // (快捷操作) 这样只有中文的括注
      .replace(/\s*\([^()\n]*\)/g, (m) => (CJK.test(m) && !/[A-Za-z]/.test(m) ? '' : m))
      // 例子全去掉后剩下的空括号；if()、days() 这样紧跟在名字后面的不动
      .replace(/ \(\s*\)/g, '')
      .replace(/\(\s*,\s*/g, '(')
      .replace(/\s*,\s*\)/g, ')')
  );
}

/** 法语的例句（"rappelle-moi …"、"jours"）：有法语字母，或者有常见的法语词。"de" 这样的语言代码太短，不算。 */
function frenchQuote(m: string): boolean {
  const inner = m.replace(/^["“「]|["”」]$/g, '');
  return (
    inner.length >= 5 &&
    /[àâçéèêëîïôûùüœ«»]|\b(rappelle|chaque|tous|jours|tableau|une|onglets|sous|accueil|seulement|moi|avec|mois|projet|pour|des|les|le|la|du|de|au|un|joindre|commander|ajouter|mettre)\b/i.test(
      inner,
    )
  );
}

/** 规则去不掉的地方：整句改写成英文。 */
// 不是界面文案（不进文案表）：写成 {from, to}，免得被当成要补法语的名称对。
const ENGLISH: readonly { from: string; to: string }[] = [
  {
    from: 'banner image, cover, 图片, 照片, 头图, 封面, 横幅图片 or 配图, ',
    to: 'banner image or cover, ',
  },
  {
    from: ', a spreadsheet from a paper table, 表格转 Excel"',
    to: ', a spreadsheet from a paper table"',
  },
  {
    from: ', letter or book page to Word, 拍文档转 Word, 图片转 Word"',
    to: ', letter or book page to Word"',
  },
];

/** 网站上的检查页和给 AI 自检用的脚本（D-594）。 */
const MAKE_PAGE_URL = 'https://tinkrum.stonetech.dev/make';
const CHECK_SCRIPT_URL = 'https://tinkrum.stonetech.dev/assets/agent/tinkrum-check.js';
/** 动作目录（D-598）：快捷操作的步骤能用哪些动作、内置的快捷操作预设。 */
const ACTIONS_FILE = 'tinkrum-app-actions.md';
const ACTIONS_URL = `https://tinkrum.stonetech.dev/assets/agent/${ACTIONS_FILE}`;
/** 结构模式（D-600）：网上模板库里常见的 8 种结构，各一份完整的 App 文件。 */
const PATTERNS_FILE = 'tinkrum-app-patterns.md';
const PATTERNS_URL = `https://tinkrum.stonetech.dev/assets/agent/${PATTERNS_FILE}`;

const requiredThemeKeys = () =>
  Object.entries(ThemeSchema.shape)
    .filter(([, s]) => !s.safeParse(undefined).success)
    .map(([k]) => k);

/**
 * App 文件的 JSON Schema。字符串的目标（page:<id>、tool:<id>、ai…）在代码里是 z.custom，JSON Schema 表达不了，
 * 写一句说明代替。
 */
export function appFileJsonSchema(): object {
  return z.toJSONSchema(AppFileSchema, {
    reused: 'ref',
    unrepresentable: 'any',
    override: (ctx) => {
      if ((ctx.zodSchema as { _zod: { def: { type: string } } })._zod.def.type === 'custom')
        ctx.jsonSchema.description =
          'A target string: "ai", a system target, "page:<page id>", "tool:<quick action id>", "app:<app id>", or {"file": null} where a file slot is allowed. See the guide.';
    },
  });
}

/** 写给别的 AI 的说明（Markdown，英文）。example 是一份能导入的 App 文件全文。 */
export function buildAgentGuide(registry: Registry, example: string): string {
  const s = promptSections(registry);
  const v = CURRENT_SCHEMA_VERSION;
  return englishOnly(`<!-- Generated by packages/planner/src/agent-guide.ts (npx vitest -u in packages/planner). Do not edit by hand. -->

# Making a Tinkrum app file

This guide is for an AI assistant (Claude, ChatGPT or any other) that a person asks to build an app for **Tinkrum**, a phone app people reshape themselves. You write one JSON file, a **Tinkrum app file**; the person imports it in Tinkrum and gets a new app next to what they already have. Nothing they have is replaced, and they can undo the import.

## What you write, and what you never write

- You write **structure only**: tables (the fields of a list of entries), pages of blocks, the app's bottom bar, its style, quick actions and reminders.
- You never write **entries** (records). Tables start empty; the person fills them in on the phone. Do not put their data, names, amounts or notes into the file, even if they told you about them; use them only to decide the structure (for example which choice options a field has).
- You never point at **files or pictures**: a file slot is \`{"file": null}\`, an image block has no \`asset\`, a picture background is left out. The person picks those on the phone. A table may still have a field of type \`file\` (photos or files on each entry): you only declare the field.
- You never write **code**. Everything is declarative JSON that Tinkrum draws with its own fixed blocks. Anything not described here does not exist.

## The file

\`\`\`json
{
  "format": "tinkrum-app",
  "version": 1,
  "schemaVersion": ${v},
  "app": { "id": "…", "name": "…", "icon": "…", "bar": ["page:…", "ai"], "theme": { … } },
  "tables": [ … ],
  "pages": [ … ],
  "tools": [ … ]
}
\`\`\`

- \`schemaVersion\` is **${v}**.
- **Every id** (the app, pages, blocks, tables, fields, choice options, quick actions, their steps, reminders) is lowercase letters, digits and "-", starts with a letter and has at most 48 characters: \`"due-date"\`, not \`"dueDate"\`, \`"due_date"\` or \`"Due date"\`. The name people see goes in \`name\`, \`title\` or \`label\`.
- \`app.id\`: the same, at most 20 characters (for example \`"plants"\`).
- **Every page, table, quick action and reminder id starts with the app id and a dash** (\`"plants-home"\`, \`"plants-care"\`). The person's phone already has pages such as \`home\`, \`toolbox\` and \`files\`; an id that is already taken stops the import. Block ids only need to be unique within their page; field ids within their table; option ids within their field.
- \`app.bar\`: 1–5 entries, each \`"page:<page id>"\` of this file or \`"ai"\` (Tink, the in-app assistant; put it last). The first entry is the page the app opens on. Settings and other system screens are not allowed in an app's bar; the person reaches them from the main Tinkrum home.
- \`app.icon\` and page/table icons: an icon name from the list in the reference, or one emoji.
- \`app.theme\` is a **complete** theme object. Required keys: ${requiredThemeKeys()
    .map((k) => `\`${k}\``)
    .join(', ')}. \`colors\` may be \`{}\`. See **Theme** in the reference.
- \`tables\`: the app's tables (see **Data**). \`pages\`: its pages (see **Containers**); there is no page \`home\` in an app file. \`tools\`: its quick actions and reminders (see **Tools**).
- Limits: at most ${MAX_PAGE_BLOCKS} top-level blocks on a page; the person's whole phone holds at most ${MAX_PAGES} pages and ${MAX_TABLES} tables, so keep an app small (2–5 pages, 1–6 tables).
- Every page needs a way in: put it in \`app.bar\`, or have an \`entry\` or \`button\` block open it, or (for a page with \`of\`, a page for one entry) have a record block's \`opens\` point at it.
- A date that comes back (a subscription that renews every month, a monthly bill, a yearly check-up) should not be a plain \`date\` field the person has to move on by hand: use a \`schedule\` field (a repeat rule each entry keeps, with \`lastDone\` pointing at the date it was last done) or a \`dateOffset\` field computed from the last date (for example the next payment = the last payment + 1 month). See **Data**, and pattern 5 in \`${PATTERNS_FILE}\`.
- Give every table that a page lists an empty state: a \`notice\` block with \`showIf: {"table": "<id>", "has": "none"}\` that says how to add the first entry.

## How to read the reference

The reference below is shared with Tink, the assistant inside Tinkrum, which changes an app one operation at a time. You do not write operations; you write the finished objects:

- \`addData {table}\` → put the table in \`tables\`.
- \`addContainer {page}\` → put the page in \`pages\`; a block added to a page → put it in that page's \`blocks\`.
- \`addTool {tool}\` → put the quick action or reminder in \`tools\`. \`addTool {tool: {preset}}\` is not available in a file: write the quick action's steps yourself, or use an \`action\` block whose tool is the preset id (that runs the built-in quick action). The actions a step can use and the preset ids are in a separate file, \`${ACTIONS_FILE}\` (${ACTIONS_URL}): read it when the app needs a quick action other than exporting entries as in the example. If you cannot get it, leave quick actions out.
- \`setTheme\` → \`app.theme\` (a whole theme object, not a patch).
- \`nav.bar\` → \`app.bar\` (with the limits above).
- \`setPackage\`, \`nav.floating\`, \`nav.phoneHomeScreen\`, \`data.calendar\` and \`containers.desk\` belong to the whole phone, not to an app file: leave them out.

Ignore what the reference says about plans, rejections, notes, drafts, earlier requests, "the user's current config", Settings and the home page: those are about Tink's conversation. Some lines mention Tink's rules by number ("rule 45"). Those rules are about Tink's conversation and are not part of this guide: ignore those mentions.

## How to work

1. Ask what the person wants to keep track of and do, in their words, if it is not clear. Do not ask for their actual data.
2. **Start from a pattern.** \`${PATTERNS_FILE}\` (${PATTERNS_URL}) holds eight proven structures, each a complete app file that imports cleanly: a log with totals by period, a category budget against spending, a goal against progress, check-ins and streaks, recurring due items, a status pipeline, a collection with a wishlist, and a parent with child logs. Pick the one closest to what the person wants (or combine two), keep its structure, and change the names, fields and wording to fit; give every id your own app's prefix. If you cannot get the file, follow the example below.
3. Write the file. Prefer fewer, well-made pages to many thin ones. Use the person's language for every name, label and text in the app.
4. **Check the file before you give it.** If you can run code with Node.js 18 or newer, run the Tinkrum checker: \`node tinkrum-check.js app.json\` (or pipe the text in: \`node tinkrum-check.js -\`). It is the same check Tinkrum runs when it imports a file, it is one file that needs nothing else, and it does not use the network. Your code environment usually cannot download it, so ask the person to attach it; they get it from ${CHECK_SCRIPT_URL}. The first line of its output is \`OK\` or \`NOT OK\`. Fix every problem it lists and run it again until it says \`OK\`; lines after \`OK\` are parts that will not work yet, so fix those too. It may then list suggestions to make the app easier to use: apply them unless the person asked for it this way. If you cannot run Node but can run Python with \`jsonschema\`, validate the file against \`tinkrum-app.schema.json\`: that only checks the shape, so tell the person the file was not fully checked. If you cannot run code, say so and point the person to the checker page, ${MAKE_PAGE_URL}.
5. Reply with the **whole file in one \`\`\`json code block**, and tell the person how to import it: copy it, then in Tinkrum open **Settings → My presets** and choose **Paste from clipboard** (or save it as a \`.json\` file and choose **Import from a file**).
6. The person may come back with a list of problems from Tinkrum or from the Tinkrum app-file checker, such as \`pages.0.blocks.2.look: "banner" is not a valid look; use one of …\` or \`pages.1.blocks.3 (block "log"): show.subtitles type is not a field of plants-care; fields of plants-care: plant, what, date, note\`. A path counts from the top of the file (\`pages.0\` is the first page); a bare name is a block, page, table or tool id. Most problems say what to write instead. Fix every problem and send the whole file again.

## A complete example

\`\`\`json
${example.trimEnd()}
\`\`\`

# Reference

## Data · containers · tools
${s.get('Data · containers · tools')!.trimEnd()}

## Data
${s.get('Data')!.trimEnd()}

## Containers
${s.get('Containers')!.trimEnd()}

## Tools
${s.get('Tools')!.trimEnd()}

## Theme
${s.get('Theme')!.trimEnd()}

## Object types

\`\`\`ts
${objectTypes(s.get('Output')!)}
\`\`\`
`);
}

/** 结构模式（D-600）：每种一段说明和一份完整的 App 文件，从 agent-patterns.ts 生成。 */
export function buildPatternsDoc(patterns: readonly AgentPattern[]): string {
  const parts = patterns.map(
    (p, i) => `## ${i + 1}. ${p.name}

**Use it when** ${p.when}.

**How it is built**

${p.how.map((h) => `- ${h}`).join('\n')}

\`\`\`json
${JSON.stringify(p.app, null, 2)}
\`\`\`
`,
  );
  return `<!-- Generated by packages/planner/src/agent-guide.ts (npx vitest -u in packages/planner). Do not edit by hand. -->

# Tinkrum app patterns

A companion to the Tinkrum app-file guide (tinkrum-app-guide.md). These are structures that personal trackers keep coming back to in the big template galleries (Notion, Airtable, Google Sheets, Microsoft, Apple Numbers), each written as a complete Tinkrum app file that imports with no problems and no design suggestions.

How to use them:

- Pick the pattern closest to what the person wants, or combine two (for example a parent with child logs whose child log has a budget).
- Keep the structure: the tables, the links and rollups, which page lists what and how an entry is added.
- Change everything that is about this example: the app id and name, ids (keep them prefixed by your own app id), field names, choice options, labels, colours and icons, in the person's language.
- The sample apps have no reminders or quick actions; add them as the guide says.

${parts.join('\n')}`;
}

/** 动作目录（D-598）：快捷操作的步骤能用的动作和内置预设，从 Tink 的提示词切出来，和指南分开放。 */
export function buildActionCatalog(registry: Registry): string {
  const s = promptSections(registry);
  return englishOnly(`<!-- Generated by packages/planner/src/agent-guide.ts (npx vitest -u in packages/planner). Do not edit by hand. -->

# Tinkrum quick actions: presets and actions

A companion to the Tinkrum app-file guide (tinkrum-app-guide.md). Read it when an app needs a quick action: the steps of a quick action in \`tools\` use the actions below, and an \`action\` block can run a built-in preset by its id. Lines that mention Tink's rules or operations (\`addTool\`, "rule 45") are about Tink, the assistant inside Tinkrum: in an app file, write the quick action into \`tools\` as the guide shows.

## Quick-action presets
${s.get('Quick-action presets')!.trimEnd()}

## Built-in tool catalog
${s.get('Built-in tool catalog')!.trimEnd()}
`);
}
