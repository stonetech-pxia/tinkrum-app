import { localDateStamp } from './field-values';
import { SITE_URL } from './site';
import { t } from './messages';
import type { Locale } from './schema';

// Handing over to another AI app (D-609, D-611): prompts for apps like ChatGPT and Claude, where
// the user selects the app and taps send in the system share sheet (invariant 10). Contains only
// guides, fixed rules, user-authored requests, and app/page names and IDs; excludes records, file
// names, and file contents (invariants 1, 2). Each paragraph is a complete sentence, written
// independently in three languages.

export const AGENT_DOCS_URL = `${SITE_URL}/assets/agent/`;

/** Name of the self-check script for other AIs during sharing (bundled in the app, D-611). */
export const CHECKER_FILE_NAME = 'tinkrum-check.js';
export const HANDOFF_DOC_FILES = ['tinkrum-app-guide.md', 'tinkrum-app-patterns.md'] as const;

export type HandoffScope =
  /** Build a new app from scratch (my preset, D-609). */
  | { kind: 'new' }
  /** Modifies the entire workspace (home screen and all apps). */
  | { kind: 'setup' }
  /** Modify an installed app; `page`: entry point page in this app (AI page context). */
  | { kind: 'app'; app: string; page?: { id: string; title: string } };

export interface HandoffOptions {
  /** Send app file as an attachment; when false, app file is written at the end of this message (fallback when native share is unavailable). */
  attached: boolean;
  /** Send checker as an attachment as well (when bundled in the app). */
  checker?: boolean;
  /** Name of the app file in attachments. */
  fileName?: string;
  /** Guides and patterns packaged locally are also attached. */
  docs?: boolean;
  /** A single sentence authored by the user in the input field and shared via share sheet to the selected app. */
  request?: string;
}

/** URL includes current date (`?v=YYYYMMDD`) so AI does not use cached older versions from previous days. */
function docsLinks(now: Date) {
  const v = localDateStamp(now);
  return {
    guide: `${AGENT_DOCS_URL}tinkrum-app-guide.md?v=${v}`,
    patterns: `${AGENT_DOCS_URL}tinkrum-app-patterns.md?v=${v}`,
  };
}

/** The prompt is stored as this file for joint sharing: some apps (Claude) drop shared text when receiving multiple files, but files are preserved. */
export const HANDOFF_REQUEST_FILE = 'tinkrum-request.md';

export function handoffPrompt(
  scope: HandoffScope,
  locale: Locale,
  now: Date,
  options: HandoffOptions = { attached: false },
): string {
  const links = docsLinks(now);
  const where =
    scope.kind === 'new'
      ? t(locale, 'handoffNew')
      : scope.kind === 'setup'
        ? t(locale, 'handoffSetup')
        : scope.page
          ? t(locale, 'handoffPage', {
              app: scope.app,
              page: scope.page.title,
              pageId: scope.page.id,
            })
          : t(locale, 'handoffApp', { app: scope.app });
  const request = options.request?.trim();
  return [
    ...(options.docs
      ? [t(locale, 'handoffReadAttached'), t(locale, 'handoffReadFallback', links)]
      : [t(locale, 'handoffRead', links)]),
    ...(scope.kind === 'new'
      ? []
      : [
          t(
            locale,
            scope.kind === 'setup'
              ? options.attached
                ? 'handoffSetupAttached'
                : 'handoffSetupInline'
              : !options.attached
                ? 'handoffInline'
                : options.checker
                  ? 'handoffAttached'
                  : 'handoffAttachedApp',
            { file: options.fileName ?? 'app.json' },
          ),
        ]),
    where,
    ...(scope.kind === 'new' ? [] : [t(locale, 'handoffRules')]),
    ...(options.checker ? [t(locale, 'handoffCheck'), t(locale, 'handoffLink')] : []),
    request
      ? t(locale, 'handoffRequest', { request })
      : t(locale, scope.kind === 'new' ? 'handoffAskNew' : 'handoffAsk'),
  ].join('\n\n');
}
