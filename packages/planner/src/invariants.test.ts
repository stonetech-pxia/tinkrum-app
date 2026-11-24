import { BUILTIN_TOOLS, createRegistry } from '@morph/core';
import { describe, expect, it } from 'vitest';

import { buildSystemPrompt, PROMPT_ROUTES } from './prompt';

// Invariant 19 (founder, 2026-10-31, conversation): what the user wants can be done; the AI cannot
// refuse a combination that can be done because it is "unreasonable", at most adding a reminder.
// Chaining itself (any actions whose types match can be chained) is tested in core's
// invariants.test.ts.

const registry = createRegistry(BUILTIN_TOOLS);
const REFUSE = /\b(reject|refuse|decline|leave (it|them) out|drop)\b/i;
const UNREASONABLE =
  /unreasonable|pointless|unnecessary|odd\b|silly|makes? no sense|doesn't make sense|not sensible/i;

describe('Invariant 19: AI does not refuse combinations that can be done', () => {
  it.each(PROMPT_ROUTES)(
    '%s prompt: no rule refuses a feasible chain for being unreasonable',
    (route) => {
      const prompt = buildSystemPrompt(registry, route);
      const sentences = prompt.split(/(?<=[.!?])\s+|\n/);
      const refusing = sentences.filter(
        (x) => REFUSE.test(x) && UNREASONABLE.test(x) && !/\bnever\b|\bdon't\b|\bnot\b/i.test(x),
      );
      expect(refusing).toEqual([]);
    },
  );

  it('the prompt says steps the user names are built even when they look odd, with at most one note', () => {
    const prompt = buildSystemPrompt(registry);
    expect(prompt).toContain('Steps the user names are always built as they ask');
    expect(prompt).toContain('never reject or leave them out for being unreasonable');
  });
});
