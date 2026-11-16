import { describe, expect, it } from 'vitest';

import { reminderWhen } from './describe';
import type { Collection, Locale, Reminder, WorkspaceConfig } from './schema';
import { workspace } from './test-helpers';

// 提醒的说明文字要说出什么时候不响（D-564）：带 unless 的每天、每周提醒（D-563）和按记录排的提醒（D-317）。
// 只出现配置里的名字（表名），不出现记录的内容。

const expenses: Collection = {
  id: 'expenses',
  name: 'Expenses',
  fields: [
    { id: 'what', name: 'What', type: 'text' },
    { id: 'kind', name: 'Kind', type: 'choice', options: [{ id: 'food', label: 'Food' }] },
  ],
};
const plants: Collection = {
  id: 'plants',
  name: 'Plants',
  fields: [
    { id: 'watered', name: 'Watered', type: 'date' },
    { id: 'plan', name: 'Plan', type: 'schedule', lastDone: 'watered' },
  ],
};

function config(locale: Locale): WorkspaceConfig {
  const c = workspace(locale);
  c.data.tables.push(expenses, plants);
  return c;
}

const daily = (unless?: Reminder['unless']): Reminder => ({
  id: 'r',
  kind: 'reminder',
  title: 'Log',
  enabled: true,
  when: { every: 'day', at: '21:00' },
  opens: 'page:home',
  ...(unless ? { unless } : {}),
});

describe('a reminder description says when it stays quiet (D-564)', () => {
  it('a daily reminder with unless names the table and the day, week or month', () => {
    const en = config('en');
    expect(reminderWhen(daily({ table: 'expenses', within: 'day' }), en, 'en')).toBe(
      'every day at 21:00, unless “Expenses” already has an entry that day',
    );
    expect(reminderWhen(daily({ table: 'expenses', within: 'week' }), en, 'en')).toBe(
      'every day at 21:00, unless “Expenses” already has an entry that week',
    );
    expect(reminderWhen(daily({ table: 'expenses', within: 'month' }), en, 'en')).toBe(
      'every day at 21:00, unless “Expenses” already has an entry that month',
    );
  });

  it('with a filter it says a matching entry, never the filter values', () => {
    const text = reminderWhen(
      daily({
        table: 'expenses',
        within: 'day',
        filter: [{ field: 'kind', op: 'is', value: 'food' }],
      }),
      config('en'),
      'en',
    );
    expect(text).toBe(
      'every day at 21:00, unless “Expenses” already has a matching entry that day',
    );
    expect(text).not.toMatch(/food/i);
  });

  it('a weekly reminder and a reminder on each entry say it too', () => {
    const en = config('en');
    expect(
      reminderWhen(
        {
          ...daily({ table: 'expenses', within: 'week' }),
          when: { every: 'week', days: [7], at: '18:00' },
        },
        en,
        'en',
      ),
    ).toMatch(/, unless “Expenses” already has an entry that week$/);
    expect(
      reminderWhen(
        {
          ...daily({ table: 'plants', within: 'day' }),
          when: { each: { table: 'plants', field: 'plan' }, at: '09:00' },
        },
        en,
        'en',
      ),
    ).toMatch(/, unless “Plants” already has an entry that day$/);
  });

  it('Chinese and French are whole sentences too', () => {
    expect(reminderWhen(daily({ table: 'expenses', within: 'day' }), config('zh'), 'zh')).toBe(
      '每天 21:00，当天「Expenses」已有记录就不提醒',
    );
    expect(reminderWhen(daily({ table: 'expenses', within: 'month' }), config('fr'), 'fr')).toBe(
      'tous les jours à 21:00, sauf si « Expenses » a déjà une entrée ce mois-là',
    );
  });

  it('without unless nothing changes', () => {
    expect(reminderWhen(daily(), config('en'), 'en')).toBe('every day at 21:00');
  });
});
