import { describe, expect, it } from 'vitest';

import { createRegistry } from '../registry';
import { WorkspaceConfigSchema, type Workflow } from '../schema';
import { BUILTIN_TOOLS } from '../tools';
import { workspace } from '../test-helpers';
import { deskToolIcon } from './icons';
import {
  DEFAULT_DESK_LAYOUT,
  DeskLayoutSchema,
  resolveDeskLayout,
  type DeskTool,
  type DeskToolsConfig,
} from './layout';
import type { DeskFile } from './model';
import {
  defaultDeskTools,
  deskInputStep,
  deskToolAsks,
  deskToolWorkflow,
  deskToolbar,
  deskWorkflowFits,
} from './tools';

// Toolbar and layout configuration for the room (file-room DESIGN §4, §5, D-358, D-359).

const registry = createRegistry(BUILTIN_TOOLS);

const f = (ext: string, mimeType: string, id = ext): DeskFile => ({
  id,
  name: id,
  ext,
  mimeType,
  size: 1000,
  path: `${id}.${ext}`,
});
const jpg = f('jpg', 'image/jpeg');
const pdf = f('pdf', 'application/pdf');
const xlsx = f('xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
const docx = f('docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

/** An action in a toolbar item (quick action items are string IDs and have no actions). */
const actionOf = (i: DeskTool) => (typeof i === 'object' ? [i.action] : []);
const actionsIn = (groups: ReturnType<typeof defaultDeskTools>, id: string) =>
  groups.find((g) => g.id === id)?.items.flatMap(actionOf) ?? [];

describe('Default toolbar: generated from registry based on file type', () => {
  it('Images: editing requires manual operation (crop, annotate, redact), processing preserves the type, and conversion changes the type', () => {
    const groups = defaultDeskTools('image', registry, [], 'zh');
    expect(groups.map((g) => g.id)).toEqual(['edit', 'adjust', 'convert', 'quick']);
    expect(actionsIn(groups, 'edit')).toEqual(
      expect.arrayContaining(['image.crop', 'image.annotate', 'image.redact', 'scan.detect']),
    );
    expect(actionsIn(groups, 'adjust')).toEqual(
      expect.arrayContaining(['image.rotate', 'image.compress', 'scan.enhance']),
    );
    expect(actionsIn(groups, 'convert')).toEqual(
      expect.arrayContaining(['pdf.fromImages', 'ocr.toExcel', 'ocr.toWord', 'ocr.recognize']),
    );
    // Selecting files, saving, sharing, and renaming are not tools ("Done" in the room handles them).
    const all = groups.flatMap((g) => g.items.flatMap(actionOf));
    expect(all.filter((a) => /^(in|out|file)\./.test(a))).toEqual([]);
    // Images do not have PDF or video tools.
    expect(all.filter((a) => /^(pdf\.(compress|sign)|video\.)/.test(a))).toEqual([]);
  });

  it('PDF categorized by purpose: annotation (draw, write, sign), pages (organize, split), processing, conversion; quick actions only include custom ones', () => {
    const groups = defaultDeskTools('pdf', registry, [], 'zh');
    expect(groups.map((g) => g.id)).toEqual(['annotate', 'pages', 'adjust', 'convert']);
    expect(actionsIn(groups, 'annotate')).toEqual(
      expect.arrayContaining(['pdf.annotate', 'pdf.sign', 'pdf.stamp', 'pdf.fillForm']),
    );
    expect(actionsIn(groups, 'pages')).toEqual(
      expect.arrayContaining(['pdf.pages', 'pdf.selectPages', 'pdf.rotate', 'pdf.split']),
    );
    expect(actionsIn(groups, 'adjust')).toEqual(expect.arrayContaining(['pdf.protect']));
    // Compression is not placed in the PDF desk; each starting tool for annotating a PDF gets its own button.
    expect(groups.flatMap((g) => g.items.flatMap(actionOf))).not.toContain('pdf.compress');
    expect(
      groups
        .find((g) => g.id === 'annotate')!
        .items.flatMap((i) =>
          typeof i === 'object' && i.action === 'pdf.annotate' ? [i.preset] : [],
        ),
    ).toEqual(['text', 'note', 'pen', 'highlight', 'box', 'erase', 'mosaic']);
    expect(actionsIn(groups, 'convert')).toEqual(
      expect.arrayContaining(['pdf.toImages', 'pdf.extractText']),
    );
    expect(actionsIn(groups, 'adjust')).not.toContain('image.rotate');
    // Built-in quick actions (convert audio, translate, etc.) are not in the PDF desk; user-defined ones are.
    const own: Workflow = {
      id: 'mine',
      kind: 'quickAction',
      name: '我的',
      steps: [
        { id: 's1', action: 'in.files', params: { accept: 'pdf', min: 1, max: 5 } },
        { id: 's2', action: 'pdf.compress', params: { maxMB: 5, whenTooBig: 'ask' } },
      ],
    };
    expect(defaultDeskTools('pdf', registry, [], 'zh').some((g) => g.id === 'quick')).toBe(false);
    expect(
      defaultDeskTools('pdf', registry, [own], 'zh').find((g) => g.id === 'quick')?.items,
    ).toEqual(['mine']);
  });

  it('Excel and Word: convert to PDF only (aggregators like merge and bundle that accept any file are excluded)', () => {
    for (const kind of ['sheet', 'doc'] as const) {
      const groups = defaultDeskTools(kind, registry, [], 'zh');
      const all = groups.flatMap((g) => g.items.flatMap(actionOf));
      expect(all).toEqual(['pdf.fromDocument']);
    }
  });

  it('Unrecognized files have no tools', () => {
    expect(defaultDeskTools('other', registry, [], 'zh')).toEqual([]);
  });

  it('Quick actions: those matching this file type appear first; single-function quick actions built into tools are excluded (to avoid duplication with tools)', () => {
    const own: Workflow = {
      id: 'mine',
      kind: 'quickAction',
      name: '我的',
      steps: [
        { id: 's1', action: 'in.photos', params: { source: 'library', min: 1, max: 30 } },
        { id: 's2', action: 'image.compress', params: { maxKB: 500, format: 'jpeg' } },
      ],
    };
    const tool: Workflow = { ...own, id: 'tool-one', package: 'image' };
    const pdfOnly: Workflow = {
      id: 'pdf-only',
      kind: 'quickAction',
      name: 'PDF',
      steps: [{ id: 's1', action: 'in.files', params: { accept: 'pdf', min: 1, max: 10 } }],
    };
    const quick = defaultDeskTools('image', registry, [tool, pdfOnly, own], 'zh').find(
      (g) => g.id === 'quick',
    )!;
    const ids = quick.items.map((i) => (typeof i === 'string' ? i : ''));
    expect(ids[0]).toBe('mine');
    expect(ids).not.toContain('tool-one');
    expect(ids).not.toContain('pdf-only');
    expect(ids.length).toBeLessThanOrEqual(8);
  });
});

describe('Using a tool = input + this tool', () => {
  it('Input steps selected based on the type and count of files on the desk', () => {
    expect(deskInputStep([jpg, { ...jpg, id: 'b' }])).toMatchObject({
      action: 'in.photos',
      params: { min: 1, max: 2 },
    });
    expect(deskInputStep([pdf])).toMatchObject({ action: 'in.files', params: { accept: 'pdf' } });
    expect(deskInputStep([xlsx])).toMatchObject({
      action: 'in.files',
      params: { accept: 'documents' },
    });
    expect(deskInputStep([jpg, pdf])).toMatchObject({
      action: 'in.files',
      params: { accept: 'pdfOrImages' },
    });
    expect(deskInputStep([f('mov', 'video/quicktime')])).toMatchObject({ action: 'in.videos' });
  });

  it('Compatible tools yield a workflow that passes validation; incompatible ones return null (appear dimmed on the toolbar)', () => {
    expect(deskToolWorkflow('image.rotate', [jpg], registry)?.steps.map((s) => s.action)).toEqual([
      'in.photos',
      'image.rotate',
    ]);
    expect(deskToolWorkflow('pdf.compress', [jpg], registry)).toBeNull();
    expect(deskToolWorkflow('pdf.fromDocument', [docx], registry)).not.toBeNull();
    // Selecting inputs and sharing cannot act as tools.
    expect(deskToolWorkflow('out.share', [jpg], registry)).toBeNull();
    expect(deskToolWorkflow('nope.nope', [jpg], registry)).toBeNull();
    expect(deskToolWorkflow('image.rotate', [], registry)).toBeNull();
  });

  it('Incomplete default parameters (e.g., text stamp requires text) are initially considered compatible; invalid filled parameters are incompatible', () => {
    expect(deskToolWorkflow('pdf.stamp', [pdf], registry)).not.toBeNull();
    expect(deskToolWorkflow('pdf.stamp', [pdf], registry, { text: '' })).toBeNull();
  });

  it('Whether a quick action can apply to files on the desk: checked by whether the first step accepts them', () => {
    const photos: Workflow = {
      id: 'p',
      kind: 'quickAction',
      name: 'p',
      steps: [{ id: 's1', action: 'in.photos', params: { source: 'library', min: 1, max: 30 } }],
    };
    expect(deskWorkflowFits(photos, [jpg])).toBe(true);
    expect(deskWorkflowFits(photos, [pdf])).toBe(false);
    expect(deskWorkflowFits(photos, [])).toBe(false);
  });
});

describe('Single tools: those that should prompt for parameters first (D-363)', () => {
  const asks = (id: string) => deskToolAsks(registry.actions.get(id)!);

  it('Recognition classes (convert to Excel, convert to Word, recognize text) and document-to-PDF do not prompt and run directly (D-278: language is automatic)', () => {
    for (const id of ['ocr.toExcel', 'ocr.toWord', 'ocr.recognize', 'pdf.fromDocument']) {
      expect([id, asks(id)]).toEqual([id, []]);
    }
  });

  it('Tools requiring parameter tuning prompt for the panel as usual: rotate asks for angle, text stamp asks for text, compression asks for size', () => {
    expect(asks('image.rotate')).toContain('angle');
    expect(asks('pdf.stamp')).toContain('text');
    expect(asks('image.compress').length).toBeGreaterThan(0);
  });

  it('Watermark only asks for text, color, and direction (Founder, 2026-11-06)', () => {
    expect(asks('pdf.stamp')).toEqual(['text', 'color', 'angle']);
  });

  it('Password is not in the panel (asked when the executor runs)', () => {
    expect(asks('pdf.protect')).not.toContain('password');
  });
});

describe('Toolbar icons (D-364)', () => {
  it('Different actions of the same tool have different icons (rotate, crop, compress, annotate, convert to PDF...)', () => {
    for (const kind of ['image', 'pdf', 'video', 'audio'] as const) {
      const items = defaultDeskTools(kind, registry, [], 'zh').flatMap((g) =>
        g.items.filter((i): i is { action: string; preset?: string } => typeof i === 'object'),
      );
      const icons = items.map((i) =>
        deskToolIcon(registry.actions.get(i.action)!, registry, i.preset),
      );
      // Most are distinct: only a few are shared (e.g., two variants of "convert to text").
      expect(new Set(icons).size).toBeGreaterThanOrEqual(Math.ceil(items.length * 0.75));
    }
    const icon = (id: string) => deskToolIcon(registry.actions.get(id)!, registry);
    expect(icon('image.rotate')).toBe(icon('pdf.rotate'));
    expect(icon('image.rotate')).not.toBe(icon('image.crop'));
    expect(icon('image.compress')).not.toBe(icon('image.resize'));
    expect(icon('ocr.toExcel')).not.toBe(icon('ocr.toWord'));
  });
});

describe('Layout configuration (confirmed by Founder, 2026-10-30: default preview centered, toolbar at bottom, AI can modify later)', () => {
  it('When unconfigured: toolbar at bottom, preview fills space, file bar present, no components above or below preview', () => {
    expect(resolveDeskLayout(undefined)).toEqual(DEFAULT_DESK_LAYOUT);
    expect(DEFAULT_DESK_LAYOUT).toMatchObject({ toolbar: 'bottom', preview: 'fill', strip: true });
  });

  it('Can customize toolbar position, preview size, file bar, explanatory components above/below preview, and tools per file type', () => {
    const layout = DeskLayoutSchema.parse({
      toolbar: 'top',
      preview: 'medium',
      strip: false,
      above: [{ id: 'tip', look: 'notice', show: { text: '先找边' } }],
      tools: { pdf: [{ title: '常用', items: [{ action: 'pdf.sign' }, 'mine'] }] },
    });
    const resolved = resolveDeskLayout(layout);
    expect(resolved).toMatchObject({ toolbar: 'top', preview: 'medium', strip: false });
    expect(resolved.above.map((c) => c.look)).toEqual(['notice']);
    expect(resolved.tools.pdf).toHaveLength(1);
  });

  it('No patterns allowed that make the preview disappear or interact with files; above and below the preview can only contain explanations and entry points', () => {
    expect(DeskLayoutSchema.safeParse({ preview: 'none' }).success).toBe(false);
    expect(DeskLayoutSchema.safeParse({ files: [] }).success).toBe(false);
    expect(DeskLayoutSchema.safeParse({ hidePreview: true }).success).toBe(false);
    const form = {
      id: 'f',
      look: 'form',
      show: { mode: 'inline' },
      tools: [{ as: 'submit', do: 'create', table: 'c', ask: ['name'] }],
    };
    expect(DeskLayoutSchema.safeParse({ below: [form] }).success).toBe(false);
    // Editing layer tools (insert row, delete block) are not actions and cannot be written into the toolbar.
    expect(
      DeskLayoutSchema.safeParse({ tools: { sheet: [{ items: [{ edit: 'insertRow' }] }] } })
        .success,
    ).toBe(false);
  });

  it('File types specified in the config use the configured settings, items pointing to non-existent tools or quick actions are hidden, and unconfigured types use defaults', () => {
    const configured: DeskToolsConfig = {
      pdf: [{ title: '常用', items: [{ action: 'pdf.sign' }, 'gone'] }],
    };
    expect(deskToolbar('pdf', configured, registry, [], 'zh')).toEqual([
      { title: '常用', items: [{ action: 'pdf.sign' }] },
    ]);
    expect(deskToolbar('image', configured, registry, [], 'zh')).toEqual(
      defaultDeskTools('image', registry, [], 'zh'),
    );
  });

  it('Workspace configuration may or may not contain containers.desk', () => {
    const config = workspace('zh');
    const withDesk = (desk: unknown) => ({
      ...config,
      containers: { ...config.containers, desk },
    });
    expect(WorkspaceConfigSchema.safeParse(config).success).toBe(true);
    expect(WorkspaceConfigSchema.safeParse(withDesk({ toolbar: 'top' })).success).toBe(true);
    expect(WorkspaceConfigSchema.safeParse(withDesk({ toolbar: 'left' })).success).toBe(false);
    // v33 position (top-level desk) is no longer recognized.
    expect(WorkspaceConfigSchema.safeParse({ ...config, desk: { toolbar: 'top' } }).success).toBe(
      false,
    );
  });
});
