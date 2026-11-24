import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_CALENDAR, type Calendar } from './calendar';
import type { DataRecord } from './data';
import { planNotifications } from './reminders';
import { allBlocks, type Locale } from './schema';
import { readChart, readNumber, readRecords, readTable, type SourceContext } from './source';
import { fromV33, v33Fixture } from './test-helpers';
import { sampleRecords, V33_NOW } from './test-records';

// v33 → v34 equivalence (D-368): configurations with data tables in fixtures/v33/ are migrated to
// v34, read out via source.ts using the same records, and compared block-by-block against the
// baseline calculated by v33 code at the time (fixtures/v33/derived/): list rows and ordering,
// sections, kanban boards, calendars, numbers (value, best, previous period, per group), charts,
// computed fields, and reminders. The v33 generator outputs "none" for unselected values.

const DERIVED = join(__dirname, 'fixtures', 'v33', 'derived');
const names = readdirSync(DERIVED)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -'.json'.length));

type Json = Record<string, unknown>;
const ids = (list: readonly DataRecord[]) => list.map((r) => r.id);
/** Serializes to JSON and reads back (stripping undefined keys) to compare against the saved fixture. */
const plain = (v: unknown): unknown =>
  v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const NONE = 'none';

function derive(name: string) {
  const config = fromV33(v33Fixture(name));
  const locale: Locale = name.endsWith('-en') ? 'en' : name.endsWith('-fr') ? 'fr' : 'zh';
  const cal = { ...DEFAULT_CALENDAR, ...(config.data.calendar ?? {}) } as Calendar;
  const records = sampleRecords(config.data.tables);
  const base: SourceContext = { config, records, now: V33_NOW, cal, locale };
  const blocks: Record<string, unknown> = {};
  for (const page of config.containers.pages) {
    const ctx: SourceContext = page.of ? { ...base, recordId: `${page.of}-0` } : base;
    for (const b of allBlocks(page)) {
      const block = b as unknown as { id: string; look: string; source?: any; show?: any };
      const key = `${page.id}/${block.id}`;
      switch (block.look) {
        case 'list':
        case 'cards':
        case 'checklist':
        case 'tiles':
        case 'board':
        case 'calendar': {
          const read = readRecords(block as Parameters<typeof readRecords>[0], ctx);
          if (!read) break;
          if (block.look === 'board')
            blocks[key] =
              read.columns?.map((c) => ({
                option: c.option,
                label: c.label,
                ids: ids(c.records),
              })) ?? null;
          else if (block.look === 'calendar')
            blocks[key] = {
              max: read.days!.max,
              days: [...read.days!.days.entries()].map(([day, d]) => ({
                day,
                count: d.count,
                optionId: d.optionId,
                ids: ids(d.records),
              })),
            };
          else if (read.groups)
            blocks[key] = read.groups.map((g) => ({
              key: g.key,
              label: g.label,
              preset: g.preset,
              ids: ids(g.records),
            }));
          else blocks[key] = ids(read.shown);
          break;
        }
        case 'number': {
          const read = readNumber(block.source, ctx);
          if (!read) break;
          blocks[key] = {
            value: read.value,
            best: read.best,
            previous: read.previous?.value,
            groups: read.groups?.map((g) => ({
              optionId: g.optionId,
              label: g.optionId === null ? NONE : g.label,
              count: g.count,
              value: g.value,
            })),
          };
          break;
        }
        case 'chart': {
          const read = readChart(block.source, ctx);
          if (!read) break;
          blocks[key] = read.points.map((p) => ({ ...p, label: p.key === null ? NONE : p.label }));
          break;
        }
        default:
          break;
      }
    }
  }
  const computed: Record<string, unknown> = {};
  for (const table of config.data.tables) {
    const fields = table.fields.filter((f) =>
      ['lookup', 'rollup', 'previous', 'formula'].includes(f.type),
    );
    if (fields.length === 0) continue;
    computed[table.id] = readTable(base, table.id)!.records.map((r) => [
      r.id,
      ...fields.map((f) => r.values[f.id] ?? null),
    ]);
  }
  const reminders = planNotifications(config, records, V33_NOW, locale);
  return { blocks, computed, reminders };
}

describe('v33 → v34: the same data reads the same (fixtures/v33/derived)', () => {
  it('has fixtures to compare', () => {
    expect(names.length).toBeGreaterThanOrEqual(18);
  });

  for (const name of names) {
    describe(name, () => {
      const expected = JSON.parse(readFileSync(join(DERIVED, `${name}.json`), 'utf8')) as {
        blocks: Json;
        computed: Json;
        reminders: unknown[];
      };
      const actual = derive(name);
      it('every block of v33 is read by v34, and no other', () => {
        expect(Object.keys(actual.blocks).sort()).toEqual(Object.keys(expected.blocks).sort());
      });
      for (const key of Object.keys(expected.blocks)) {
        it(`block ${key}`, () => {
          expect(plain(actual.blocks[key])).toEqual(expected.blocks[key]);
        });
      }
      it('computed fields (lookup, rollup, previous, formula)', () => {
        expect(plain(actual.computed)).toEqual(expected.computed);
      });
      it('reminder schedules', () => {
        expect(plain(actual.reminders)).toEqual(expected.reminders);
      });
    });
  }
});
