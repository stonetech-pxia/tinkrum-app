import {
  SITE_URL,
  AppFileSchema,
  CURRENT_SCHEMA_VERSION,
  MAX_DRAWN_ICON_CHARS,
  MAX_DRAWN_ICON_PATHS,
  MAX_DRAWN_ICONS,
  MAX_PAGE_BLOCKS,
  MAX_PAGES,
  MAX_TABLES,
  ThemeSchema,
  type Registry,
} from '@morph/core';
import { z } from 'zod';

import type { AgentPattern } from './agent-patterns';
import { buildSystemPrompt } from './prompt';

// App file writing instructions for other AIs (D-593): users ask them to generate a tinkrum-app
// file, then import from "My Presets". The first part is the App file's own rules (hand-written),
// and subsequent references are sliced from Tink's prompts by "## " headings. Looks, fields,
// actions, styles, and themes share the same definitions with Tink, so changing the registry
// updates both sides simultaneously. Snapshot tests write this into docs/agent/ (updated with
// vitest -u).

/**
 * These sections from the prompt are placed into references (headings unchanged). Action catalogs
 * and quick action presets are in a separate file, read only when performing quick actions
 * (D-598).
 */
const SECTIONS = [
  'Data · containers · tools',
  'Data',
  'Containers',
  'Tools',
  'Theme',
  'Output',
  'Rules',
  'Quick-action presets',
  'Built-in tool catalog',
] as const;

/**
 * Tink's Rules regarding "what the App can do and how to write it" (D-604): aggregation,
 * schedules, row buttons, display formats, days(), also... Since the short guide (D-598) removed
 * the Rules section entirely, other AIs lack knowledge of these patterns and cannot implement
 * them, hence placing them in a separate rule file. Rules specifically about Tink conversation,
 * drafts, and the entire phone (home screen, workspace files, image backgrounds, style
 * terminology) are omitted.
 */
const FEATURE_RULES: ReadonlySet<number> = new Set([
  10, 13, 32, 33, 34, 35, 38, 40, 42, 43, 44, 45, 46, 47, 48, 49, 50, 55, 56, 58, 59, 60, 61, 62,
  63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 77, 78, 79,
]);
/** Quick action rules: placed in the action catalog. */
const QUICK_ACTION_RULES: ReadonlySet<number> = new Set([15, 20, 21, 22, 28, 29, 30, 31, 54]);

/** Pick these rules from Rules (starting from "N. " up to the next rule). */
function pickRules(rules: string, wanted: ReadonlySet<number>): string {
  const out: string[] = [];
  let keep = false;
  for (const line of rules.split('\n')) {
    const n = /^(\d+)\. /.exec(line);
    if (n) keep = wanted.has(Number(n[1]));
    if (keep) out.push(line);
  }
  return out.join('\n');
}

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

/** Output section retains only object types (Block, Page, Table...), while Plan and Op are Tink response formats. */
function objectTypes(output: string): string {
  const from = output.indexOf('type Target');
  const to = output.indexOf('type Plan =');
  if (from < 0 || to < from) throw new Error('prompt Output section changed shape');
  return output.slice(from, to).trimEnd();
}

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
/** Quoted string segment: English quotes, curly quotes, corner brackets (corner brackets may appear inside English quotes, so they are processed last). */
const QUOTED = String.raw`(?:"[^"\n]*"|“[^”\n]*”|「[^」\n]*」)`;
const SEP = String.raw`(?:\s*,\s*|\s*\/\s*|\s+or\s+)`;

/**
 * Tink's prompts contain Chinese and French example sentences and names (as users would say
 * them), but documentation for other AIs should be English only (Founder 2026-11-19): remove
 * quoted segments with Chinese along with adjacent separators ("Open photo library" -> "Open
 * photo library"), remove entire "Chinese → example" pairs, and remove Chinese-only parenthetical
 * notes; rewrite any unremovable instances in ENGLISH. Tests ensure no Chinese remains in the
 * output.
 */
function englishOnly(text: string): string {
  const other = (m: string) => CJK.test(m) || frenchQuote(m);
  let out = text;
  for (const { from, to } of ENGLISH) out = out.split(from).join(to);
  return (
    out
      // "Merge-date" → "Merge-{date}", such whole pairs
      .replace(new RegExp(`${QUOTED}\\s*→\\s*${QUOTED}(?:,\\s*)?`, 'g'), (m) =>
        other(m.slice(0, m.indexOf('→'))) ? '' : m,
      )
      .replace(new RegExp(`${SEP}${QUOTED}`, 'g'), (m) => (other(m) ? '' : m))
      .replace(new RegExp(`${QUOTED}${SEP}`, 'g'), (m) => (other(m) ? '' : m))
      .replace(new RegExp(QUOTED, 'g'), (m) => (other(m) ? '' : m))
      // (Quick action) such Chinese-only parenthetical notes
      .replace(/\s*\([^()\n]*\)/g, (m) => (CJK.test(m) && !/[A-Za-z]/.test(m) ? '' : m))
      // Empty parentheses left after removing all examples; keep if() or days() tightly following names
      .replace(/ \(\s*\)/g, '')
      .replace(/\(\s*,\s*/g, '(')
      .replace(/\s*,\s*\)/g, ')')
  );
}

/** French example sentences ("rappelle-moi ...", "jours"): contain French letters or common French words. Language codes like "de" are too short and not counted. */
function frenchQuote(m: string): boolean {
  const inner = m.replace(/^["“「]|["”」]$/g, '');
  return (
    inner.length >= 5 &&
    /[àâçéèêëîïôûùüœ«»]|\b(rappelle|chaque|tous|jours|tableau|une|onglets|sous|accueil|seulement|moi|avec|mois|projet|pour|des|les|le|la|du|de|au|un|joindre|commander|ajouter|mettre)\b/i.test(
      inner,
    )
  );
}

/** Where rules cannot be removed: rewrite the entire sentence into English. */
// Not interface copy (excluded from message tables): written as {from, to} to avoid being treated as French naming pairs to supplement.
const ENGLISH: readonly { from: string; to: string }[] = [
  {
    from: 'banner image, cover, 图片, 照片, 头图, 封面, 横幅图片 or 配图, ',
    to: 'banner image or cover, ',
  },
  { from: '(改动记录, the bottom-bar entry "history")', to: '(the bottom-bar entry "history")' },
  { from: '(图片工具, "the PDF tool"', to: '("the image tool", "the PDF tool"' },
  { from: '("添加图片工具" = setPackage', to: '("add the image tool" = setPackage' },
  { from: '"移除 PDF 工具" = setPackage', to: '"remove the PDF tool" = setPackage' },
  {
    from: 'A goal ("喝水显示今天的进度，目标 8 杯" →',
    to: 'A goal ("show today\'s water against a goal of 8 glasses" →',
  },
  { from: '"压缩这条记录的 PDF" →', to: '"compress this entry\'s PDF" →' },
  { from: '(fewer is better: "本月 本星期" →', to: '(fewer is better: "this month, this week" →' },
  { from: 'e.g. "全年合计不用跟着变")', to: 'e.g. "the yearly total stays as it is")' },
  { from: '"导出搜索到的", an export button', to: '"export what I searched", an export button' },
  {
    from: ', a spreadsheet from a paper table, 表格转 Excel"',
    to: ', a spreadsheet from a paper table"',
  },
  {
    from: ', letter or book page to Word, 拍文档转 Word, 图片转 Word"',
    to: ', letter or book page to Word"',
  },
  {
    from: 'unless ("今天已经打过卡就别提醒")',
    to: 'unless ("don\'t remind me if I already checked in today")',
  },
];

/** Check page on website and self-check script for AI (D-594). */
const MAKE_PAGE_URL = `${SITE_URL}/make`;
const CHECK_SCRIPT_URL = `${SITE_URL}/assets/agent/tinkrum-check.js`;
/** Action catalog (D-598): available actions for quick action steps and built-in quick action presets. */
const ACTIONS_FILE = 'tinkrum-app-actions.md';
const ACTIONS_URL = `${SITE_URL}/assets/agent/${ACTIONS_FILE}`;
/** Structural patterns (D-603): 8 common structures in the online template library (9th added in D-616), each with a complete App file. */
const PATTERNS_FILE = 'tinkrum-app-patterns.md';
/** Feature rules (D-604): several rules from Tink's Rules regarding what Apps can do. */
const RULES_FILE = 'tinkrum-app-rules.md';
const RULES_URL = `${SITE_URL}/assets/agent/${RULES_FILE}`;
const PATTERNS_URL = `${SITE_URL}/assets/agent/${PATTERNS_FILE}`;

const requiredThemeKeys = () =>
  Object.entries(ThemeSchema.shape)
    .filter(([, s]) => !s.safeParse(undefined).success)
    .map(([k]) => k);

/**
 * JSON Schema for App files. String targets (page:<id>, tool:<id>, ai...) use z.custom in code
 * which JSON Schema cannot express, replaced with descriptive text.
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

/** Instructions for other AIs (Markdown, English). example is the full text of an importable App file. */
export function buildAgentGuide(registry: Registry, example: string): string {
  const s = promptSections(registry);
  const v = CURRENT_SCHEMA_VERSION;
  return englishOnly(`<!-- Generated by packages/planner/src/agent-guide.ts (npx vitest -u in packages/planner). Do not edit by hand. -->

# Making a Tinkrum app file

This guide is for an AI assistant (Claude, ChatGPT or any other) that a person asks to build an app for **Tinkrum**, a phone app people reshape themselves. You write one JSON file, a **Tinkrum app file**; the person imports it in Tinkrum and gets a new app next to what they already have. They can undo the import.

## What you write, and what you never write

- You write **structure only**: tables (the fields of a list of entries), pages of blocks, the app's bottom bar, its style, quick actions and reminders.
- You never write **entries** (records). Tables start empty; the person fills them in on the phone. Do not put their data, names, amounts or notes into the file, even if they told you about them; use them only to decide the structure.
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
- \`app.bar\`: 1–5 entries, each \`"page:<page id>"\` of this file or \`"ai"\` (Tink, the in-app assistant; put it last). The first entry is the page the app opens on. Settings and other system screens are not allowed in an app's bar.
- \`app.icon\` and page/table icons: an icon name from the list in the reference, one emoji, or \`"my:<id>"\` of an icon you draw in the file's \`icons\` (see **Drawing icons**).
- \`app.theme\` is a **complete** theme object. Required keys: ${requiredThemeKeys()
    .map((k) => `\`${k}\``)
    .join(', ')}. \`colors\` may be \`{}\`. See **Theme** in the reference.
- \`tables\`: the app's tables (see **Data**). \`pages\`: its pages (see **Containers**); there is no page \`home\` in an app file. \`tools\`: its quick actions and reminders (see **Tools**).
- Limits: at most ${MAX_PAGE_BLOCKS} top-level blocks on a page; the person's whole phone holds at most ${MAX_PAGES} pages and ${MAX_TABLES} tables, so keep an app small (2–5 pages, 1–6 tables).
- Every page needs a way in: put it in \`app.bar\`, or have an \`entry\` or \`button\` block open it, or (for a page with \`of\`, a page for one entry) have a record block's \`opens\` point at it.
- A date that comes back (a monthly bill, a yearly check-up) should not be a plain \`date\` field the person moves on by hand: use a \`schedule\` field (a repeat rule each entry keeps, with \`lastDone\` pointing at the date it was last done) or a \`dateOffset\` field computed from the last date (the next payment = the last payment + 1 month). See **Data**, and pattern 5 in \`${PATTERNS_FILE}\`. A reminder some days before (\`when.before\`) only watches a \`date\` or \`dateOffset\` field, never a \`schedule\` (\`when.each\` comes on the due day itself): for a warning days ahead, keep the next due day in a \`date\` field and let the row button that marks it paid move it on, as pattern 5 shows.
- Values a filter on a \`schedule\` field takes with \`"op": "due"\`: \`today\` (overdue included), \`overdue\`, \`thisWeek\` or \`pending\`, nothing else. "Due this month" is \`{"op": "inPeriod", "value": "thisMonth"}\` on the same field, which reads its next date.
- A \`single\` block shows 1–8 fields; for more, put a second \`single\` block below it.
- A list cannot be sorted by a \`link\` field (\`source.sort\`, \`show.browse.sort\`). To sort by the linked entry's name, add a \`lookup\` field of that name and sort by it; grouping by a link field works.
- Give every table that a page lists an empty state: a \`notice\` block with \`showIf: {"table": "<id>", "has": "none"}\` that says how to add the first entry.

## Drawing icons

When no listed icon fits and the person wants the app's own icons (a paw for pets), draw them in a top-level \`icons\` object next to \`pages\`: \`"icons": {"paw": {"paths": ["…"]}}\`, and write \`"icon": "my:paw"\` where it goes. Every \`"my:<id>"\` must be defined in \`icons\`, or the import stops.

- Ids: lowercase letters, digits and "-", starting with a letter, at most 24 characters; at most ${MAX_DRAWN_ICONS} icons.
- Canvas 24 by 24, (0,0) at the top left; 1–${MAX_DRAWN_ICON_PATHS} paths, at most ${MAX_DRAWN_ICON_CHARS} characters in all, starting with M; only the path commands M L H V C S Q T A Z and plain numbers (no exponents, no \`<svg>\`, styles or links).
- Filled (even-odd: a shape inside another is a hole) or \`"stroke": true\` (lines 2 wide, round ends). One colour, taken from where it is used. One clear silhouette, about 2 units of margin; never a real brand's logo.
- Example, a dumbbell in lines: \`{"paths": ["M6 8v8M18 8v8M3 10v4M21 10v4M6 12h12"], "stroke": true}\`.

## How to read the reference

The reference below is shared with Tink, the assistant inside Tinkrum, which changes an app one operation at a time. You do not write operations; you write the finished objects:

- \`addData {table}\` → put the table in \`tables\`.
- \`addContainer {page}\` → put the page in \`pages\`; a block added to a page → put it in that page's \`blocks\`.
- \`addTool {tool}\` → put the quick action or reminder in \`tools\`. \`addTool {tool: {preset}}\` is not available in a file: write the quick action's steps yourself, or use an \`action\` block whose tool is the preset id (that runs the built-in quick action). The actions a step can use and the preset ids are in a separate file, \`${ACTIONS_FILE}\` (${ACTIONS_URL}): read it when the app needs a quick action other than exporting entries as in the example. If you cannot get it, leave quick actions out.
- \`setTheme\` → \`app.theme\` (a whole theme object, not a patch).
- \`nav.bar\` → \`app.bar\` (with the limits above).
- \`setPackage\`, \`nav.floating\`, \`nav.phoneHomeScreen\`, \`data.calendar\` and \`containers.desk\` belong to the whole phone, not to an app file: leave them out.

Ignore what the reference says about plans, rejections, notes, drafts, earlier requests, "the user's current config", Settings and the home page: they are about Tink's conversation. Rule numbers ("rule 45") refer to Tink's rules: the ones about what an app can do are in \`${RULES_FILE}\` (${RULES_URL}), the ones about quick actions in \`${ACTIONS_FILE}\`. Read a rule there when you need it (a progress bar, a timer, a date that repeats, one tap that changes two things). Rules about Tink's conversation and the whole phone are left out: ignore a mention of a rule you cannot find.

## How to work

1. If it is not clear, ask what the person wants to keep track of and do. Never ask for their data.
2. **Start from a pattern.** \`${PATTERNS_FILE}\` (${PATTERNS_URL}) holds eight proven structures, each a complete app file that imports cleanly: a log with totals by period, a category budget against spending, a goal against progress, check-ins and streaks, recurring due items, a status pipeline, a collection with a wishlist, and a parent with child logs. Pick the closest (or combine two), keep its structure, change the names, fields and wording, and give every id your own app's prefix. If you cannot get the file, follow the example below.
3. Write the file. Prefer fewer, well-made pages to many thin ones, in the person's language.
4. **Check the file before you give it.** If you can run code with Node.js 18 or newer, run the Tinkrum checker: \`node tinkrum-check.js app.json\` (or pipe the text in: \`node tinkrum-check.js -\`). It is the same check Tinkrum runs on import, is one file that needs nothing else and does not use the network. Your environment usually cannot download it, so ask the person to attach it; they get it from ${CHECK_SCRIPT_URL}. The first line of its output is \`OK\` or \`NOT OK\`. Fix every problem it lists and run it again until it says \`OK\`; lines after \`OK\` will not work yet, so fix those too, and its suggestions: apply them unless the person asked for it this way. Without Node but with Python and \`jsonschema\`, validate against \`tinkrum-app.schema.json\` (shape only: tell the person the file was not fully checked). If you cannot run code, say so and point the person to the checker page, ${MAKE_PAGE_URL}.
5. Reply with the **whole file in one \`\`\`json code block** and tell the person how to import it: copy it, then in Tinkrum open **Settings → Apps and presets**, tap **Add an app** and **Paste from clipboard** (or save a \`.json\` file and choose **Import from a file**).
6. The person may come back with a list of problems from Tinkrum or the checker, such as \`pages.0.blocks.2.look: "banner" is not a valid look; use one of …\`. A path counts from the top of the file (\`pages.0\` is the first page); a bare name is a block, page, table or tool id. Most problems say what to write instead. Fix every problem and send the whole file again.

## Changing an existing file

The person may send an existing file to change. Entries stay on the phone, linked to ids:

- **Keep every id that is already there**: the app, tables, fields, choice options, pages, blocks, quick actions and reminders. Add new things with new ids. A changed id is a new thing: the old table's entries stay on the phone but no longer show in this app.
- Do not remove a table, a field or a choice option unless the person asks. Their entries keep the values, hidden.
- A field's type can change only between \`number\` and \`money\`, or between \`text\` and \`note\`. For any other change (text to date, choice to number…), add a new field with a new id and leave the old one.
- When the message says which page the person came from, a request that does not name a place ("make the title bigger", "add a button") is about that page.
- Change only what was asked; return the **whole** file. Tinkrum offers to update the same app by id, with undo.

## Whole setups and returning files

A \`morph-app-config\` file wraps the whole workspace in \`config\`. Keep its wrapper, ids and unrequested parts; do not extract a sub-app. After OK, put its exact \`Open in Tinkrum\` URL (if it prints one) first as a clickable link; never build or shorten it. Also return the whole JSON block. Tinkrum previews before applying.

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

/**
 * Feature rules (D-604): rules from Tink's Rules on what Apps can do and how to write them,
 * placed in a separate file, read only when needed. Testing showed no benefit in appending them
 * to the main guide (design suggestions tied when patterns were present, but main guide
 * lengthened by 70%), while documentation must still be available.
 */
export function buildRulesDoc(registry: Registry): string {
  const s = promptSections(registry);
  return englishOnly(`<!-- Generated by packages/planner/src/agent-guide.ts (npx vitest -u in packages/planner). Do not edit by hand. -->

# Tinkrum app rules: how to build what people ask for

A companion to the Tinkrum app-file guide (tinkrum-app-guide.md). Read the rule you need when an app calls for something the guide and the patterns don't show: totals and streaks from a linked table (rule 42), dates that repeat (43, 47, 50), one-tap buttons on entries (44, 61, 62, 63), grouping and calendars (45), progress or a running timer on a list row (46), a page for one entry (48, 58), days left until a date (32), reminders (35, 59, 60, 66), tabs and time ranges on a page (56, 65), the entry form's layout (64), fixed zones and block sizes (55, 67).

These rules come from Tink, the assistant inside Tinkrum, which changes an app one operation at a time: where a rule names an operation (\`addData\`, \`addContainer\`, \`addTool\`, \`updateData\`…), write the finished object into the file instead, as the guide's "How to read the reference" says. Rules about Tink's conversation and about the whole phone are left out, so the numbers have gaps: when a rule mentions one that is not here, ignore that mention.

## Rules
${pickRules(s.get('Rules')!, FEATURE_RULES)}
`);
}

/** Structural patterns (D-603): each has a description section and a complete App file, generated from agent-patterns.ts. */
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

/** Action catalog (D-598): actions usable in quick action steps and built-in presets, sliced from Tink's prompt and separated from the guide. */
export function buildActionCatalog(registry: Registry): string {
  const s = promptSections(registry);
  return englishOnly(`<!-- Generated by packages/planner/src/agent-guide.ts (npx vitest -u in packages/planner). Do not edit by hand. -->

# Tinkrum quick actions: presets and actions

A companion to the Tinkrum app-file guide (tinkrum-app-guide.md). Read it when an app needs a quick action: the steps of a quick action in \`tools\` use the actions below, and an \`action\` block can run a built-in preset by its id. Lines that mention Tink's rules or operations (\`addTool\`, "rule 45") are about Tink, the assistant inside Tinkrum: in an app file, write the quick action into \`tools\` as the guide shows.

## Quick-action presets
${s.get('Quick-action presets')!.trimEnd()}

## Built-in tool catalog
${s.get('Built-in tool catalog')!.trimEnd()}

## Rules for quick actions
${pickRules(s.get('Rules')!, QUICK_ACTION_RULES)}
`);
}
