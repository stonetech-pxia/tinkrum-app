import {
  BUILTIN_TOOLS,
  createRegistry,
  type Collection,
  type DataRecord,
  type Workflow,
} from '@morph/core';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { startRun } from '../runtime/runner';
import type { LocalUi } from '../runtime/local';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles } from '../test-utils/fake-files';
import { openFieldLink } from '../renderer/open-link';
jest.mock('../renderer/open-link', () => ({ openFieldLink: jest.fn() }));
const registry = createRegistry(BUILTIN_TOOLS);
const people: Collection = {
  id: 'people',
  name: 'People',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'email', name: 'Email', type: 'text', format: 'email' },
    { id: 'amount', name: 'Amount', type: 'money', currency: 'EUR' },
  ],
};
const templates: Collection = {
  id: 'templates',
  name: 'Templates',
  fields: [
    { id: 'title', name: 'Title', type: 'text' },
    { id: 'body', name: 'Body', type: 'note' },
    { id: 'subject', name: 'Subject', type: 'text' },
    { id: 'doc', name: 'Word', type: 'file' },
  ],
};
const record = (id: string, collectionId: string, values: Record<string, unknown>): DataRecord => ({
  id,
  collectionId,
  values,
  createdAt: 1,
  updatedAt: 1,
});
function setup(kind = 'text') {
  const repo = new MemoryWorkspaceRepo(),
    files = new FakeFiles();
  let n = 0;
  const ui: LocalUi = {
    confirm: jest.fn(async () => false),
    choose: jest.fn(async () => 0),
    open: jest.fn(async () => null),
  };
  const params = {
    collectionId: 'people',
    templatesTable: 'templates',
    kind,
    ...(kind === 'word' ? { document: ['doc'] } : { body: ['body'] }),
    ...(kind === 'email' ? { subject: ['subject'], recipient: ['email'] } : {}),
  };
  const workflow: Workflow = {
    id: 'fill',
    kind: 'quickAction',
    name: 'Fill',
    steps: [{ id: 'fill', action: 'records.fill', params }],
  };
  const handed = {
    type: 'records' as const,
    collectionId: 'people',
    name: 'People',
    records: [
      record('p', 'people', { name: 'Maria & Co', email: 'maria@example.com', amount: 12.5 }),
    ],
  };
  const run = () =>
    startRun({
      workflow,
      revisionId: 1,
      repo,
      files,
      registry,
      locale: 'fr',
      now: () => new Date(2026, 10, 23),
      newId: () => `id${++n}`,
      ui,
      collections: [people, templates],
      handed,
    });
  const add = (id: string, values: Record<string, unknown>) =>
    repo.insertRecord(record(id, 'templates', values));
  return { repo, files, ui, workflow, handed, run, add };
}
beforeEach(() => jest.clearAllMocks());
it('new user: no template fails without writing or opening mail', async () => {
  const s = setup();
  expect((await s.run()).result.status).toBe('failed');
  expect(openFieldLink).not.toHaveBeenCalled();
  expect(s.files.disk.size).toBe(0);
});
it('fills text in French using only the handed entry and names the output after the template', async () => {
  const s = setup();
  await s.add('t', { title: 'Letter', body: 'Bonjour {Name}, {Amount}' });
  const result = (await s.run()).result;
  expect(result.status).toBe('succeeded');
  if (result.status === 'succeeded')
    expect(result.value).toMatchObject({
      type: 'text',
      name: 'Letter',
      text: expect.stringContaining('Bonjour Maria & Co, 12,50'),
    });
  expect(await s.repo.listRecords('people')).toEqual([]);
});
it('offers only matching templates, and cancellation leaves no files or messages', async () => {
  const s = setup();
  await s.add('empty', { title: 'Empty' });
  await s.add('a', { title: 'A', body: '{Name}' });
  await s.add('b', { title: 'B', body: 'Hello' });
  const run = await s.run();
  expect(run.result.status).toBe('cancelled');
  expect(s.ui.open).toHaveBeenCalledWith(
    'recordPick',
    expect.objectContaining({
      records: expect.arrayContaining([
        expect.objectContaining({ id: 'a' }),
        expect.objectContaining({ id: 'b' }),
      ]),
    }),
  );
  expect(s.files.disk.size).toBe(0);
});
it('leaves unknown placeholders intact and asks before handing the result on', async () => {
  const s = setup();
  await s.add('t', { title: 'Letter', body: '{Name}: {Unknown}' });
  const result = (await s.run()).result;
  expect(result.status).toBe('succeeded');
  expect(s.ui.choose).toHaveBeenCalledWith(
    expect.any(String),
    expect.stringContaining('Unknown'),
    expect.any(Array),
  );
  if (result.status === 'succeeded')
    expect(result.value).toMatchObject({ text: 'Maria & Co: {Unknown}' });
});
it('fills a Word file in place, with an original that remains unchanged', async () => {
  const s = setup('word');
  const original = zipSync({
    'word/document.xml': strToU8(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{Na</w:t></w:r><w:r><w:t>me}</w:t></w:r></w:p></w:body></w:document>',
    ),
  });
  s.files.disk.set('assets/doc/letter.docx', original);
  await s.repo.addAsset({
    id: 'doc',
    name: 'letter.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: original.length,
    path: 'assets/doc/letter.docx',
    source: 'picked',
    createdAt: 1,
  });
  await s.add('t', { title: 'Welcome', doc: ['doc'] });
  const run = await s.run();
  expect(run.result.status).toBe('succeeded');
  if (run.result.status === 'succeeded' && run.result.value && 'items' in run.result.value) {
    const [f] = run.result.value.items;
    expect(f).toMatchObject({ name: 'Welcome', ext: 'docx' });
    expect(strFromU8(unzipSync(s.files.disk.get(f!.uri)!)['word/document.xml']!)).toContain(
      'Maria &amp; Co',
    );
  }
  expect(s.files.disk.get('assets/doc/letter.docx')).toEqual(original);
  await run.dispose();
  expect(s.files.disk.size).toBe(1);
});
it('opens a draft email with encoded recipient, subject and body and never sends it', async () => {
  const s = setup('email');
  await s.add('t', {
    title: 'Mail',
    subject: 'Hello {Name}',
    body: 'Value: {Amount}\n&bcc=other@example.com',
  });
  expect((await s.run()).result.status).toBe('succeeded');
  expect(openFieldLink).toHaveBeenCalledTimes(1);
  const [link] = (openFieldLink as jest.Mock).mock.calls[0]!;
  expect(link.url).toMatch(/^mailto:maria@example.com\?subject=Hello%20Maria%20%26%20Co&body=/);
  expect(link.url).toContain('%26bcc%3D');
});
it('selects one of several source entries and fills only that entry', async () => {
  const s = setup();
  await s.add('t', { title: 'Letter', body: 'Hello {Name}' });
  s.handed.records.push({ ...s.handed.records[0]!, id: 'p2', values: { name: 'Zoé' } });
  (s.ui.open as jest.Mock).mockResolvedValue({ recordId: 'p2' });
  const r = (await s.run()).result;
  expect(s.ui.open).toHaveBeenCalledWith(
    'recordPick',
    expect.objectContaining({
      collection: expect.objectContaining({ id: 'people' }),
      records: expect.arrayContaining([expect.objectContaining({ id: 'p2' })]),
    }),
  );
  expect(r.status).toBe('succeeded');
  if (r.status === 'succeeded') expect(r.value).toMatchObject({ type: 'text', text: 'Hello Zoé' });
});
it('cancelling the source selection does not choose a template or open mail', async () => {
  const s = setup('email');
  await s.add('t', { title: 'Mail', subject: 'Hello', body: '{Name}' });
  s.handed.records.push({ ...s.handed.records[0]!, id: 'p2' });
  expect((await s.run()).result.status).toBe('cancelled');
  expect(s.ui.open).toHaveBeenCalledTimes(1);
  expect(openFieldLink).not.toHaveBeenCalled();
});
it('after in.records, chooses one entry, opens one email draft, then copies the filled body', async () => {
  const s = setup('email');
  await s.add('t', { title: 'Mail', subject: 'Hi', body: 'Hello {Name}' });
  for (const r of [
    ...s.handed.records,
    { ...s.handed.records[0]!, id: 'p2', values: { name: 'Zoé', email: 'zoe@example.com' } },
  ])
    await s.repo.insertRecord(r);
  (s.ui.open as jest.Mock).mockResolvedValue({ recordId: 'p2' });
  s.workflow.steps.unshift({
    id: 'read',
    action: 'in.records',
    params: { collectionId: 'people', period: 'all' },
  });
  s.workflow.steps.push({ id: 'copy', action: 'text.copy', params: {} });
  expect((await s.run()).result.status).toBe('succeeded');
  expect(openFieldLink).toHaveBeenCalledTimes(1);
  expect((openFieldLink as jest.Mock).mock.calls[0]![0].url).toContain('mailto:zoe@example.com');
  expect(s.files.clipboard).toBe('Hello Zoé');
});
it('rejects a different input table before reading a template', async () => {
  const s = setup();
  s.handed.collectionId = 'other';
  expect((await s.run()).result.status).toBe('failed');
  expect(s.ui.open).not.toHaveBeenCalled();
});
it('selects the source and template independently when both have several entries', async () => {
  const s = setup();
  await s.add('a', { title: 'A', body: 'First {Name}' });
  await s.add('b', { title: 'B', body: 'Second {Name}' });
  s.handed.records.push({ ...s.handed.records[0]!, id: 'p2', values: { name: 'Zoé' } });
  (s.ui.open as jest.Mock)
    .mockResolvedValueOnce({ recordId: 'p2' })
    .mockResolvedValueOnce({ recordId: 'b' });
  const r = (await s.run()).result;
  expect(r.status).toBe('succeeded');
  if (r.status === 'succeeded')
    expect(r.value).toMatchObject({ type: 'text', name: 'B', text: 'Second Zoé' });
  expect((s.ui.open as jest.Mock).mock.calls.map((c) => c[1].collection.id)).toEqual([
    'people',
    'templates',
  ]);
});
