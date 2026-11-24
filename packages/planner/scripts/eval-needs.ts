import { readFileSync, writeFileSync } from 'node:fs';

import { BUILTIN_TOOLS, createRegistry } from '@morph/core';
import { EVAL_CASES, buildSetup } from '@morph/core/src/eval';

// Extracts each passing case's round-by-round utterances and plan operations from evaluation --dump
// files (apps/api/scripts/eval.ts), keeping only what route tests need (operation name, block
// looks, tool kinds), and writes to src/__fixtures__/eval-turns.json. Usage: npx tsx
// scripts/eval-needs.ts <dump.json>...

export interface SlimOp {
  op: string;
  /** Looks used by blocks in addContainer / updateContainer (including those in groups), and whether blocks have tools. */
  looks?: string[];
  tools?: boolean;
  /** Which keys are changed in updateContainer nav. */
  nav?: string[];
  /** Tools: reminder / quickAction / preset; those with steps are step modifications. */
  kind?: string;
  step?: boolean;
}

export interface EvalTurn {
  id: string;
  input: string;
  ops: SlimOp[];
}

type Block = { look?: string; tools?: unknown[]; children?: Block[] };
const blocksIn = (b: Block | undefined): Block[] =>
  b ? [b, ...(b.children ?? []).flatMap((c) => blocksIn(c))] : [];

const registry = createRegistry(BUILTIN_TOOLS);

function slim(op: Record<string, unknown>, reminders: Set<string>): SlimOp {
  const s: SlimOp = { op: String(op.op) };
  const page = op.page as { blocks?: Block[] } | string | undefined;
  const blocks = [
    ...blocksIn(op.block as Block | undefined),
    ...(typeof page === 'object' ? (page.blocks ?? []).flatMap((b) => blocksIn(b)) : []),
  ];
  const changes = op.changes as { tools?: unknown } | undefined;
  if (blocks.length) s.looks = [...new Set(blocks.map((b) => String(b.look)))];
  if (blocks.some((b) => b.tools?.length) || changes?.tools) s.tools = true;
  if (op.nav) s.nav = Object.keys(op.nav as object);
  const tool = op.tool as { kind?: string; preset?: string } | string | undefined;
  if (typeof tool === 'object') s.kind = tool.preset ? 'preset' : (tool.kind ?? 'quickAction');
  if (typeof tool === 'string') s.kind = reminders.has(tool) ? 'reminder' : 'quickAction';
  if (op.step) s.step = true;
  return s;
}

const turns = new Map<string, EvalTurn>();
for (const file of process.argv.slice(2)) {
  const dump = JSON.parse(readFileSync(file, 'utf8')) as Record<
    string,
    { pass: boolean; plans: { kind: string; ops?: Record<string, unknown>[]; next?: string }[] }
  >;
  for (const c of EVAL_CASES) {
    const run = dump[c.id];
    if (!run?.pass) continue;
    const config = buildSetup(c.setup, c.locale, registry);
    const reminders = new Set(config.tools.filter((t) => t.kind === 'reminder').map((t) => t.id));
    run.plans.forEach((plan, i) => {
      const input = i === 0 ? c.input : run.plans[i - 1]!.next!;
      for (const op of plan.ops ?? []) {
        const t = op.tool as { kind?: string; id?: string } | undefined;
        if (op.op === 'addTool' && t?.kind === 'reminder' && t.id) reminders.add(t.id);
      }
      const ops = (plan.ops ?? []).map((op) => slim(op, reminders));
      const turn = { id: c.id, input, ops };
      turns.set(JSON.stringify(turn), turn);
    });
  }
}
const out = [...turns.values()].sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(
  new URL('../src/__fixtures__/eval-turns.json', import.meta.url),
  `${JSON.stringify(out)}\n`,
);
console.log(`${out.length} turns`);
