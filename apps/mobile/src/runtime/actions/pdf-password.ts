import { RunCancelled, RunError, type ActionImpl, type RunItem } from '@morph/core';

import { displayName, fileItems, freshName, type RunServices } from './helpers';

// PDF Password (D-194): Remove open password, add open password. iOS uses PDFKit
// (modules/morph-docs); Android and Expo Go do not (P-025), reporting unsupported at runtime.
// Passwords are used only for this run, not saved, and not logged in run history.

type Impl = ActionImpl<RunServices>;

function passwordsOf(ctx: Parameters<Impl>[2]) {
  const passwords = ctx.services.files.documents.passwords;
  if (!passwords) throw new RunError('pdfPasswordUnsupported');
  return passwords;
}

async function lockStateOf(ctx: Parameters<Impl>[2], item: RunItem) {
  try {
    return await passwordsOf(ctx).lockState(item.uri);
  } catch (e) {
    if (e instanceof RunError) throw e;
    throw new RunError('unreadable', { name: displayName(item) });
  }
}

export const PDF_PASSWORD_IMPLS: Record<string, Impl> = {
  async 'pdf.unlock'(input, _params, ctx) {
    const passwords = passwordsOf(ctx);
    const items = fileItems(input);
    const out: RunItem[] = [];
    for (const [i, item] of items.entries()) {
      ctx.throwIfCancelled();
      // Other files like images are passed to the next step as-is (e.g., photos merged with statements).
      const state = item.mimeType === 'application/pdf' ? await lockStateOf(ctx, item) : 'none';
      if (state === 'none') {
        out.push(item);
        continue;
      }
      // Files that can be opened without a password and only restrict printing and copying are not unlocked (P-027).
      if (state === 'restricted') throw new RunError('pdfRestricted', { name: displayName(item) });
      let wrong = false;
      for (;;) {
        const answer = await ctx.services.ui.open('password', {
          name: displayName(item),
          wrong,
          index: i,
          total: items.length,
        });
        if (!answer) throw new RunCancelled();
        if ('skip' in answer) break;
        const unlocked = await passwords.unlock(
          item.uri,
          answer.password,
          ctx.services.runId,
          freshName(item.name, 'pdf'),
        );
        if (unlocked) {
          out.push({ ...item, uri: unlocked.uri, size: unlocked.size });
          break;
        }
        wrong = true;
      }
    }
    if (out.length === 0) throw new RunError('tooFew', { min: 1, kind: 'PDF' });
    return { ...input!, items: out } as typeof input & { items: RunItem[] };
  },

  async 'pdf.protect'(input, _params, ctx) {
    const passwords = passwordsOf(ctx);
    const password = ctx.secrets.password;
    if (!password) throw new RunError('passwordMissing');
    const items = fileItems(input);
    const out: RunItem[] = [];
    for (const [i, item] of items.entries()) {
      ctx.throwIfCancelled();
      ctx.progress(i, items.length);
      if ((await lockStateOf(ctx, item)) !== 'none') {
        throw new RunError('encrypted', { name: displayName(item) });
      }
      const done = await passwords.protect(
        item.uri,
        password,
        ctx.services.runId,
        freshName(item.name, 'pdf'),
      );
      out.push({ ...item, uri: done.uri, size: done.size });
    }
    ctx.progress(items.length, items.length);
    return { type: 'pdf', items: out };
  },
};
