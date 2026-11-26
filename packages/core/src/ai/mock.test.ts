import { describe, expect, it } from 'vitest';

import { prepareOps } from '../change';
import { t } from '../messages';
import { sampleOps } from '../samples';
import { THEME_PRESETS, THEME_PRESET_IDS, presetRequest, type ThemePresetId } from '../presets';
import { isKnownComponent, quickActionsOf, type Locale, type WorkspaceConfig } from '../schema';
import { PAPER_APP_REQUEST, createStarterWorkspace } from '../starter';
import { apply, registry, workspace } from '../test-helpers';
import { checkTools } from '../tool-check';
import { functionFirst } from './kinds';
import { createMockAIProvider } from './mock';
import { fixRequest } from './session';
import type { Plan } from './types';

// Each test case corresponds to a sentence pattern ID in docs/MOCK_AI_PHRASES.md.

const ai = createMockAIProvider();
const now = new Date(2026, 9, 22, 9, 0);

async function plan(input: string, config: WorkspaceConfig, locale: Locale = 'zh'): Promise<Plan> {
  return ai.plan(input, { config, registry, locale });
}

/** Have the mock generate a plan, and obtain the modified configuration via the same `prepareOps` pipeline used by the app. */
async function change(input: string, config: WorkspaceConfig, locale: Locale = 'zh') {
  const p = await plan(input, config, locale);
  if (p.kind !== 'ops') throw new Error(`expected ops for “${input}”, got ${JSON.stringify(p)}`);
  const prepared = prepareOps(config, p.ops, { registry, locale, now });
  if (!prepared.ok) throw new Error(`invalid change for “${input}”: ${prepared.issues.join('; ')}`);
  return { ...prepared, plan: p };
}

/** Perform feature changes first, then select the "continue editing" option (D-191): data pages require two sentences. */
async function changeThenNext(input: string, config: WorkspaceConfig, locale: Locale = 'zh') {
  const first = await change(input, config, locale);
  if (!first.plan.next) throw new Error(`expected a next request for “${input}”`);
  return change(first.plan.next, first.after, locale);
}

const home = (c: WorkspaceConfig) => c.containers.pages.find((p) => p.id === 'home')!;
const homeIds = (c: WorkspaceConfig) => home(c).blocks.map((x) => x.id);
const mergeSteps = (c: WorkspaceConfig) =>
  quickActionsOf(c).find((w) => w.id === 'pdf-merge')!.steps;

// PDF is not at the top of the home view, so moving it to the top is an actual modification.
const pdfBelowFiles = () =>
  apply(workspace('zh', { withPdf: true }), [
    { op: 'moveContainer', page: 'home', block: 'card-pdf', toIndex: 3 },
  ]);

describe('mock AI — journey A (home page)', () => {
  it('A1 full sentence: title, PDF on top, nav trimmed (AI and History stay in Settings)', async () => {
    const { after, lines } = await change(
      '把首页改成文件工作台，把 PDF 放到最上面，导航栏只保留首页、工具、设置。',
      pdfBelowFiles(),
    );
    expect(home(after).title).toBe('文件工作台');
    expect(home(after).blocks[0]).toMatchObject({
      look: 'header',
      show: { title: '文件工作台' },
    });
    expect(homeIds(after)).toEqual(['welcome', 'card-pdf', 'catalog', 'recent-files']);
    expect(after.nav.bar).toEqual(['page:home', 'tools', 'settings']);
    expect(after.nav.floating).toEqual([]);
    expect(lines).toContain('修改标题「我的工作台」：标题改为「文件工作台」');
  });

  it('A2 "PDF put first"', async () => {
    expect(homeIds((await change('PDF 放第一个', pdfBelowFiles())).after)[1]).toBe('card-pdf');
  });

  it('A3 "Navigation only home, tools, and settings"', async () => {
    const { after } = await change('导航只要首页、工具和设置', workspace());
    expect(after.nav.bar).toEqual(['page:home', 'tools', 'settings']);
  });

  it('A4 "Home changed to file workspace"', async () => {
    expect(home((await change('首页改成文件工作台', workspace())).after).title).toBe('文件工作台');
  });

  it('A5 “Put PDF at the top”', async () => {
    expect(homeIds((await change('Put PDF at the top', pdfBelowFiles(), 'en')).after)[1]).toBe(
      'card-pdf',
    );
  });

  it('A6 “Only keep Home, Tools and Settings in the navigation”', async () => {
    const { after } = await change(
      'Only keep Home, Tools and Settings in the navigation',
      workspace('en'),
      'en',
    );
    expect(after.nav.bar).toEqual(['page:home', 'tools', 'settings']);
    expect(after.nav.floating).toEqual([]);
  });

  it('PDF already on top is not a change', async () => {
    expect(await plan('把 PDF 放到最上面', workspace('zh', { withPdf: true }))).toMatchObject({
      kind: 'reject',
      reason: 'noChange',
    });
  });

  it('mentions of an uninstalled tool are rejected with a hint', async () => {
    expect(await plan('把 PDF 放到最上面', workspace())).toMatchObject({
      kind: 'reject',
      reason: 'notInstalled',
    });
  });
});

describe('mock AI — single changes', () => {
  it('B1 theme color', async () => {
    expect((await change('主题换成绿色', workspace())).after.theme.primaryColor).toBe('#2F9E44');
    expect((await change('主题色改成蓝色', workspace())).after.theme.primaryColor).toBe('#1C7ED6');
  });

  it('B2 dark mode', async () => {
    expect((await change('切换到深色模式', workspace())).after.theme.mode).toBe('dark');
  });

  it('B3 hide and show the welcome card', async () => {
    const hidden = (await change('隐藏欢迎卡片', workspace())).after;
    expect(home(hidden).blocks[0]!.hidden).toBe(true);
    expect(home((await change('显示欢迎卡片', hidden)).after).blocks[0]!.hidden).toBeUndefined();
  });

  it('B4 "Put recent files before PDF"', async () => {
    const { after } = await change('把最近文件放到 PDF 前面', workspace('zh', { withPdf: true }));
    expect(homeIds(after)).toEqual(['welcome', 'recent-files', 'card-pdf', 'catalog']);
  });
});

describe('mock AI — style', () => {
  it('B5/B6 text size', async () => {
    const bigger = (await change('字体大一点', workspace())).after;
    expect(bigger.theme.fontScale).toBe(1.15);
    expect((await change('Bigger text', workspace('en'), 'en')).after.theme.fontScale).toBe(1.15);
    expect((await change('字小一点', workspace())).after.theme.fontScale).toBe(0.9);
    // Do not modify further when the upper limit is reached.
    const max = apply(workspace(), [{ op: 'setTheme', fontScale: 1.3 }]);
    expect(await plan('字体大一点', max)).toMatchObject({ kind: 'reject', reason: 'noChange' });
  });

  it('B7 corners', async () => {
    expect((await change('圆角小一点', workspace())).after.theme.radius).toBe(14);
    expect((await change('去掉圆角', workspace())).after.theme.radius).toBe(0);
    expect((await change('圆角大一点', workspace())).after.theme.radius).toBe(28);
  });

  it('B8 density', async () => {
    expect((await change('紧凑一点', workspace())).after.theme.density).toBe('compact');
    expect((await change('宽松一点', workspace())).after.theme.density).toBe('spacious');
  });

  it('B9 card style', async () => {
    expect((await change('去掉阴影', workspace())).after.theme.cardStyle).toBe('flat');
    expect((await change('卡片加边框', workspace())).after.theme.cardStyle).toBe('outline');
    expect((await change('卡片改成新粗野风格', workspace())).after.theme.cardStyle).toBe('brutal');
    expect((await change('卡片换成新拟物', workspace())).after.theme.cardStyle).toBe('soft');
    expect((await change('卡片用黏土质感', workspace())).after.theme.cardStyle).toBe('puffy');
    expect((await change('Neumorphic cards', workspace('en'), 'en')).after.theme.cardStyle).toBe(
      'soft',
    );
    expect((await change('卡片改成毛玻璃', workspace())).after.theme.cardStyle).toBe('glass');
    expect((await change('卡片改成霓虹发光', workspace())).after.theme.cardStyle).toBe('glow');
    expect((await change('卡片换成金属质感', workspace())).after.theme.cardStyle).toBe('chrome');
  });

  it('B12b style presets by name', async () => {
    const cases: [string, string][] = [
      ['换成 iOS 风格', 'ios'],
      ['换成杂志风', 'editorial'],
      ['风格改成马卡龙', 'pastel'],
      ['用赛博朋克风格', 'neon'],
      ['换成新粗野风格', 'brutalist'],
      ['切换到新拟物风格', 'neumorphism'],
      ['换成黏土风', 'claymorphism'],
      ['换成毛玻璃风格', 'glass'],
      ['换成 Y2K 风格', 'y2k'],
    ];
    for (const [input, preset] of cases) {
      const { after } = await change(input, workspace());
      expect(after.theme).toEqual(THEME_PRESETS[preset as ThemePresetId].theme);
    }
    expect((await change('Switch to terminal style', workspace('en'), 'en')).after.theme).toEqual(
      THEME_PRESETS.terminal.theme,
    );
    // Statements that only modify cards or colors remain unaffected.
    expect((await change('卡片改成新粗野风格', workspace())).after.theme.colors).toEqual({});
    expect((await change('主题换成绿色', workspace())).after.theme.cardStyle).toBe('shadow');
  });

  // The style selector for the French UI also sends this sentence to the built-in rules (D-234).
  it.each(
    THEME_PRESET_IDS.flatMap((id) => (['zh', 'en', 'fr'] as const).map((l) => [id, l] as const)),
  )(
    'B12c the style picker sentence for %s (%s) applies exactly that preset',
    async (id, locale) => {
      const p = await plan(presetRequest(id, locale), workspace(locale), locale);
      expect(p).toEqual({ kind: 'ops', ops: [{ op: 'setTheme', preset: id }] });
    },
  );

  // The two preset tags on the AI page: sentences bypass the model and directly apply a complete template (receipts, business cards).
  it.each(
    (['zh', 'en', 'fr'] as const).flatMap((l) =>
      (
        [
          ['wantReceiptsChip', 'receipts'],
          ['wantCardsChip', 'business-cards'],
        ] as const
      ).map(([key, sample]) => [key, sample, l] as const),
    ),
  )('B12d the %s sentence (%s, %s) adds the whole sample', async (key, sample, locale) => {
    const config = workspace(locale);
    const p = await plan(t(locale, key), config, locale);
    const expected = sampleOps(sample, config, locale);
    expect(expected.ok).toBe(true);
    expect(p).toEqual({ kind: 'ops', ops: expected.ok ? expected.ops : [] });
  });

  it('B9d page backdrop', async () => {
    expect((await change('背景改成极光', workspace())).after.theme.backdrop).toBe('aurora');
    expect((await change('页面背景换成渐变', workspace())).after.theme.backdrop).toBe('gradient');
    expect((await change('Aurora background', workspace('en'), 'en')).after.theme.backdrop).toBe(
      'aurora',
    );
  });

  it('B10 navigation bar style', async () => {
    expect((await change('导航栏只显示图标', workspace())).after.theme.navStyle).toBe('icon');
    expect((await change('导航栏只显示文字', workspace())).after.theme.navStyle).toBe('label');
  });

  it('B11 font', async () => {
    expect((await change('字体换成系统字体', workspace())).after.theme.font).toBe('system');
    expect((await change('字体改成衬线', workspace())).after.theme.font).toBe('serif');
  });

  it('B12 reset the style', async () => {
    const styled = apply(workspace(), [
      { op: 'setTheme', primaryColor: '#2F9E44', radius: 0, density: 'compact' },
    ]);
    expect((await change('恢复默认样式', styled)).after.theme).toEqual(workspace().theme);
  });
});

describe('mock AI — navigation and pages', () => {
  it('B13 AI, History and Tools can be removed; Settings still has AI and History', async () => {
    const { after } = await change('把 AI 入口删掉', workspace());
    expect(after.nav.bar).toEqual(['page:home', 'tools', 'history', 'settings']);
    expect(after.nav.floating).toEqual([]);
    const noHistory = (await change('把历史从导航栏移除', after)).after;
    expect(noHistory.nav.bar).toEqual(['page:home', 'tools', 'settings']);
    expect((await change('remove tools', workspace('en'), 'en')).after.nav.bar).toEqual([
      'page:home',
      'ai',
      'history',
      'settings',
    ]);
  });

  it('B14 make an entry a floating button', async () => {
    const { after } = await change('把 AI 做成浮动按钮', workspace());
    expect(after.nav.floating).toEqual(['ai']);
    expect(after.nav.bar).not.toContain('ai');
  });

  it('E1 adds a page with an entry in the nav bar, or on the home page when the bar is full', async () => {
    const trimmed = apply(workspace(), [
      { op: 'updateContainer', nav: { bar: ['page:home', 'settings'] } },
    ]);
    const { after } = await change('新建一个叫「记账」的页面', trimmed);
    const page = after.containers.pages.find((p) => p.title === '记账')!;
    expect(page).toMatchObject({ id: 'page-1', blocks: [{ look: 'header' }] });
    expect(after.nav.bar).toEqual(['page:home', 'page:page-1', 'settings']);

    const full = (await change('Add a page called Budget', workspace('en'), 'en')).after;
    expect(full.nav.bar).toHaveLength(5);
    expect(home(full).blocks.at(-1)).toMatchObject({
      look: 'button',
      opens: 'page:page-1',
    });
  });

  it('E2 removes a page the user added', async () => {
    const added = (await change('新建一个叫「记账」的页面', workspace())).after;
    const { after } = await change('删除记账页面', added);
    expect(after.containers.pages.map((p) => p.id)).toEqual(['home']);
    expect(
      home(after).blocks.some(
        (c) => isKnownComponent(c) && c.look === 'button' && c.opens === 'page:page-1',
      ),
    ).toBe(false);
    expect(await plan('删除首页页面', workspace())).toMatchObject({ kind: 'reject' });
  });
});

describe('mock AI — data pages (structure only)', () => {
  it.each([
    ['新建一个记账页面', 'zh', '账目'],
    ['新建待办清单', 'zh', '待办'],
    ['做一个读书清单', 'zh', '书单'],
    ['新建笔记页面', 'zh', '笔记'],
    ['Create a to-do list', 'en', 'To-dos'],
  ] as const)('F1 “%s” builds the data table, then the page', async (input, locale, table) => {
    // Data tables are features and executed immediately; pages are appearance and left as the next sentence for "continue editing" (D-191).
    const first = await change(input, workspace(locale), locale);
    expect(first.after.data.tables.map((c) => c.name)).toEqual([table]);
    expect(first.after.containers.pages).toHaveLength(1);
    expect(first.plan.next).toMatch(/^增加.+页面$|^Add a .+ page$/);
    const { after, plan: second } = await change(first.plan.next!, first.after, locale);
    expect(after.data.tables.map((c) => c.name)).toEqual([table]);
    expect(after.containers.pages).toHaveLength(2);
    expect(second.next).toBeUndefined();
  });

  it('F1 a second budget page gets a table of its own', async () => {
    const budget = (await changeThenNext('新建一个记账页面', workspace())).after;
    const { after, plan: p } = await change('新建一个记账页面', budget);
    expect(after.data.tables.map((c) => c.id)).toEqual(['expenses', 'expenses-2']);
    const { after: paged } = await change(p.next!, after);
    expect(paged.containers.pages.find((x) => x.id === 'budget-2')).toBeDefined();
  });

  it('D-191 a sentence with a function and a look change does the function first', async () => {
    const { after, plan: p } = await change(
      '主题换成绿色，添加签证照片快捷操作，首页改成文件工作台',
      workspace(),
    );
    expect(quickActionsOf(after).map((w) => w.id)).toContain('visa-photo');
    expect(after.theme.primaryColor).not.toBe('#2F9E44');
    expect(home(after).title).toBe('首页');
    expect(p.next).toBe('主题换成绿色，首页改成文件工作台');
    const { after: looked, plan: second } = await change(p.next!, after);
    expect(looked.theme.primaryColor).toBe('#2F9E44');
    expect(second.next).toBeUndefined();
  });

  it('D-191 English look clauses come back as sentences', async () => {
    const { plan: p } = await change(
      'Add the visa photo quick action. Change the theme color to green',
      workspace('en'),
      'en',
    );
    expect(p.next).toBe('Change the theme color to green');
  });

  it('F2 adds a field to a table', async () => {
    const budget = (await changeThenNext('新建一个记账页面', workspace())).after;
    const { after, lines } = await change('给账目加一个「支付方式」字段', budget);
    expect(after.data.tables[0]!.fields.at(-1)).toEqual({
      id: 'field-1',
      name: '支付方式',
      type: 'text',
    });
    expect(lines).toEqual(['给「账目」加字段「支付方式」（文字）']);
  });

  it.each([
    '记一笔午饭 35',
    '把上个月的账都删掉',
    '把待办都标成完成',
    '我这个月花了多少',
    'delete all my expenses',
  ])('X4 “%s” touches recorded data and is refused', async (input) => {
    const budget = (await changeThenNext('新建一个记账页面', workspace())).after;
    expect(await plan(input, budget, /[a-z]/.test(input) ? 'en' : 'zh')).toMatchObject({
      kind: 'reject',
      reason: 'userData',
    });
  });
});

describe('mock AI — attachments (D-263)', () => {
  it.each([
    ['给账目加照片', 'zh'],
    ['账目里存发票', 'zh'],
    ['给账目加附件', 'zh'],
    ['Attach receipts to Expenses', 'en'],
    ['add photos to expenses', 'en'],
  ] as const)('AT “%s” adds an attachment field and no quick action', async (input, locale) => {
    const budget = (
      await changeThenNext(
        locale === 'zh' ? '新建一个记账页面' : 'Create a budget page',
        workspace(locale),
        locale,
      )
    ).after;
    const { after, lines } = await change(input, budget, locale);
    const fields = after.data.tables.find((c) => c.id === 'expenses')!.fields;
    expect(fields.filter((f) => f.type === 'file')).toHaveLength(1);
    expect(after.tools).toEqual(budget.tools);
    expect(lines.join('\n')).toMatch(locale === 'zh' ? /附件/ : /Attachments/);
    // An attachment field already exists: no need to change; explains where to put photos.
    expect(await plan(input, after, locale)).toMatchObject({ kind: 'reject', reason: 'noChange' });
  });
});

describe('mock AI — images and icons', () => {
  it('G1 adds an empty image slot; the user picks the photo later', async () => {
    const { after, lines } = await change('在首页顶部加一张横幅', workspace());
    expect(home(after).blocks[1]).toEqual({
      id: 'image-1',
      look: 'image',
      show: { aspect: 'wide', fit: 'cover', placeholder: '点按选择一张照片' },
    });
    expect(lines).toEqual(['在「首页」添加图片']);
    const en = await change('Add a photo to the home page', workspace('en'), 'en');
    expect(home(en.after).blocks.at(-1)).toMatchObject({
      look: 'image',
      show: { aspect: 'landscape' },
    });
  });

  it('G2 sets an emoji as a page icon', async () => {
    const budget = (await changeThenNext('新建一个记账页面', workspace())).after;
    const { after } = await change('把记账页面的图标换成💰', budget);
    expect(after.containers.pages.find((p) => p.title === '记账')!.icon).toBe('💰');
    expect(await plan('把记账页面的图标换成钱', budget)).toMatchObject({ kind: 'reject' });
  });
});

describe('mock AI — journey C (PDF tool)', () => {
  it('C1 simplifies to pick + merge, saves automatically as merge-date', async () => {
    const { after, lines } = await change(
      '把 PDF 工具首页简化成上传和合并两个步骤，完成后自动按照‘合并-日期’命名',
      workspace('zh', { withPdf: true }),
    );
    expect(mergeSteps(after).map((s) => s.action)).toEqual([
      'in.files',
      'pdf.merge',
      'file.rename',
      'file.save',
    ]);
    // Preserve the naming but no longer prompt.
    expect(mergeSteps(after)[2]).toEqual({
      id: 'name',
      action: 'file.rename',
      params: { template: '合并-{date:YYYY-MM-DD}' },
    });
    // Still the same tool instance.
    expect(after.packages).toHaveLength(1);
    expect(quickActionsOf(after).filter((w) => w.id === 'pdf-merge')).toHaveLength(1);
    expect(lines.some((l) => l.includes('合并-2026-10-22'))).toBe(true);
  });

  it('C2 "Merged files named by date" changes the naming only', async () => {
    const { after } = await change('合并后的文件按日期命名', workspace('zh', { withPdf: true }));
    expect(mergeSteps(after).map((s) => s.id)).toEqual(['select', 'merge', 'name', 'save']);
    expect(mergeSteps(after)[2]).toEqual({
      id: 'name',
      action: 'file.rename',
      params: { template: '{date:YYYY-MM-DD}' },
      ask: ['template'],
    });
  });
});

describe('mock AI — journey D (undo / restore)', () => {
  it.each(['恢复上一次修改前的界面', '撤销刚才的修改', 'Undo the last change'])(
    '%s',
    async (input) => {
      expect(await plan(input, workspace())).toEqual({ kind: 'restorePrevious' });
    },
  );

  it('undo mixed with other changes is rejected', async () => {
    expect(await plan('撤销刚才的修改，主题换成绿色', workspace())).toMatchObject({
      kind: 'reject',
    });
  });
});

describe('mock AI — must refuse', () => {
  it('X1 unrelated request: “I don’t understand” with examples, no guessing', async () => {
    const p = await plan('帮我订一张机票', workspace());
    expect(p).toMatchObject({ kind: 'reject', reason: 'unknown' });
    if (p.kind === 'reject') expect(p.examples.length).toBeGreaterThan(0);
  });

  it('X2 removing Settings is refused as protected', async () => {
    expect(await plan('把设置删掉', workspace())).toMatchObject({
      kind: 'reject',
      reason: 'protected',
    });
    expect(await plan('hide settings', workspace('en'), 'en')).toMatchObject({
      kind: 'reject',
      reason: 'protected',
    });
  });

  it('X3 deleting files is refused', async () => {
    expect(await plan('删除我所有的 PDF 文件', workspace('zh', { withPdf: true }))).toMatchObject({
      kind: 'reject',
      reason: 'deleteFiles',
    });
  });

  it('one unknown clause rejects the whole sentence', async () => {
    expect(await plan('主题换成绿色，顺便帮我写首诗', workspace())).toMatchObject({
      kind: 'reject',
      reason: 'unknown',
    });
  });

  it('words that merely contain “ai” are not treated as the AI entry', async () => {
    expect(await plan('remove the email', workspace('en'), 'en')).toMatchObject({
      reason: 'unknown',
    });
  });
});

describe('mock AI — guide step 1 (D-645)', () => {
  it('GD1 guide step 1 builds the Paper app in the interface language', async () => {
    for (const locale of ['zh', 'en', 'fr'] as const) {
      const start = createStarterWorkspace(locale, registry);
      const { after } = await change(PAPER_APP_REQUEST[locale], start, locale);
      expect(after.nav.apps).toMatchObject([
        {
          id: 'paper',
          name: 'Paper',
        },
      ]);
      // French titles stay French although the other built-in rules answer in English.
      expect(after.containers.pages.find((p) => p.id === 'paper-home')!.title).toBe(
        { zh: '首页', en: 'Home', fr: 'Accueil' }[locale],
      );
    }
  });

  it('says nothing changes when the Paper app is already there', async () => {
    const ai = createMockAIProvider();
    const start = createStarterWorkspace('zh', registry);
    const { after } = await change(PAPER_APP_REQUEST.zh, start, 'zh');
    const again = await ai.plan(PAPER_APP_REQUEST.zh, { config: after, registry, locale: 'zh' });
    expect(again).toMatchObject({ kind: 'reject', reason: 'noChange' });
  });
});

// D-265: Sentences with no UI entry point and unlikely to be uttered by users are no longer recognized by built-in rules (handled by the real model; evaluations remain unchanged).
describe('mock AI — sentences removed in D-265', () => {
  it.each([
    ['图标改成浅色底', 'zh'],
    ['Use solid icon backgrounds', 'en'],
    ['首页入口改成列表', 'zh'],
    ['快捷操作改成列表', 'zh'],
    ['按钮只显示图标', 'zh'],
    ['首页加上照片快捷操作', 'zh'],
    ['Show all quick action categories on home', 'en'],
    ['首页加上Tinkrum 可以做什么', 'zh'],
    ['我有一堆旅行照片，想发给朋友', 'zh'],
    ['I shot a video and it’s too big to send', 'en'],
    ['我有好几份 PDF 合同，想合成一份加上页码，发邮件给律师', 'zh'],
    ['新建一个快捷操作：选视频，视频静音，分享', 'zh'],
    ['Create a quick action: choose photos, remove background, share', 'en'],
    ['添加收据快捷操作', 'zh'],
  ] as const)('%s', async (text, locale) => {
    expect(await plan(text, workspace(locale, { withPdf: true }), locale)).toMatchObject({
      kind: 'reject',
      reason: 'unknown',
    });
  });
});

describe('mock AI — record reports (W9)', () => {
  it('reads the period from the sentence, including the longer ones (D-285)', async () => {
    const budget = (await changeThenNext('新建一个记账页面', workspace())).after;
    const name = budget.data.tables[0]!.name;
    for (const [words, period] of [
      ['本月', 'thisMonth'],
      ['最近 90 天', 'last90days'],
      ['最近一年', 'last365days'],
    ]) {
      const { after } = await change(`把${words}的${name}做成 PDF 报表`, budget);
      const added = quickActionsOf(after).find(
        (w) => !quickActionsOf(budget).some((x) => x.id === w.id),
      )!;
      expect(added.steps[0]!.params).toMatchObject({ period });
    }
  });
});

describe('Fix these (D-418)', () => {
  async function step(config: WorkspaceConfig, input: string) {
    const plan = await ai.plan(input, { config, registry, locale: 'zh' });
    if (plan.kind !== 'ops') throw new Error(`${input}: ${plan.kind}`);
    const r = prepareOps(config, plan.ops, { registry, locale: 'zh', now, fromAI: true });
    if (!r.ok) throw new Error(r.issues.join('; '));
    return r.after;
  }
  const blockers = (config: WorkspaceConfig) =>
    checkTools(config, registry).issues.filter((i) => i.severity === 'blocker');

  it('Table has nowhere to view: put a list on the home screen, problem disappears', async () => {
    let config = createStarterWorkspace('zh', registry);
    config = await step(config, '新建一个记账页面');
    config = await step(config, '新建一个快捷操作：拍照，记到账目');
    expect(blockers(config).map((i) => i.code)).toEqual(['view-missing']);
    const after = await step(config, fixRequest(blockers(config)));
    expect(blockers(after)).toEqual([]);
  });

  it('Cannot fill, do not guess: reject', async () => {
    const config = createStarterWorkspace('zh', registry);
    const plan = await ai.plan(
      fixRequest([{ severity: 'blocker', code: 'x', target: 'table:x', message: 'x' }]),
      { config, registry, locale: 'zh' },
    );
    expect(plan.kind).toBe('reject');
  });

  it('Setup plan with "missing page": table has nowhere to view after completion (for testing buttons in simulator)', async () => {
    const start = createStarterWorkspace('zh', registry);
    const plan = await ai.plan('搭建一个记账 App，缺页面', {
      config: start,
      registry,
      locale: 'zh',
    });
    if (plan.kind !== 'build') throw new Error(plan.kind);
    let config = start;
    for (const s of plan.steps) {
      const ctx = {
        config,
        registry,
        locale: 'zh' as const,
        session: { open: [], recent: [], step: { index: 1, total: 3, remaining: 2 } },
      };
      const p = await ai.plan(s.request, ctx);
      if (p.kind !== 'ops') throw new Error(`${s.request}: ${p.kind}`);
      expect(p.next ?? null).toBeNull();
      const r = prepareOps(config, p.ops, { registry, locale: 'zh', now, fromAI: true });
      if (!r.ok) throw new Error(r.issues.join('; '));
      config = r.after;
    }
    expect(blockers(config).map((i) => i.code)).toEqual(['view-missing']);
  });
});

describe('MX1: Both features and appearance in a single plan (D-419)', () => {
  it('Features and appearance are separable, both can be applied', async () => {
    const config = workspace();
    const result = await plan('做个月历（混合计划）', config);
    if (result.kind !== 'ops') throw new Error(result.kind);
    const ctx = { registry, locale: 'zh' as const, now };
    const first = functionFirst(config, result.ops, ctx);
    if (first.kind !== 'function') throw new Error(first.kind);
    expect(first.deferred).toHaveLength(2);
    const fn = prepareOps(config, first.ops, ctx);
    if (!fn.ok) throw new Error(fn.issues.join('; '));
    const look = prepareOps(fn.after, first.deferred, ctx);
    expect(look).toMatchObject({ ok: true });
  });
});
