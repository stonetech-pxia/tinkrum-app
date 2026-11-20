import { describe, expect, it } from 'vitest';

import { closest, idFrom } from './suggest';

describe('idFrom', () => {
  it('writes a wrong id the way ids are written', () => {
    expect(idFrom('opening_balance')).toBe('opening-balance');
    expect(idFrom('dueDate')).toBe('due-date');
    expect(idFrom('Due date')).toBe('due-date');
    expect(idFrom('2nd_try')).toBe('nd-try');
    expect(idFrom('日期')).toBeUndefined();
  });
});

describe('closest', () => {
  it('guesses only when it is close', () => {
    expect(closest('descending', ['asc', 'desc'])).toBe('desc');
    expect(closest('plans', ['name', 'plan', 'part'])).toBe('plan');
    expect(closest('Opening_Balance', ['opening-balance', 'kind'])).toBe('opening-balance');
    expect(closest('plants-logs', ['plants-plants', 'plants-care'])).toBeUndefined();
  });
});
