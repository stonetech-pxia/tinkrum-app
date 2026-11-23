import { localDateStamp } from './field-values';
import { SITE_URL } from './site';
import { t } from './messages';
import type { Locale } from './schema';

// 交给别的 AI App（D-609、D-611）：给 ChatGPT、Claude 这类 App 的提示词，用户在系统分享面板里自己挑 App、
// 自己点发送（底线 10）。只有指南、固定规则、用户主动写下的要求，和 App、页面的名字和 ID；不带记录、文件名、文件内容（底线 1、2）。每段是一整句话，三种语言各写各的。

export const AGENT_DOCS_URL = `${SITE_URL}/assets/agent/`;

/** 给别的 AI 自检用的脚本在分享时叫什么（打包在 App 里，D-611）。 */
export const CHECKER_FILE_NAME = 'tinkrum-check.js';
export const HANDOFF_DOC_FILES = ['tinkrum-app-guide.md', 'tinkrum-app-patterns.md'] as const;

export type HandoffScope =
  /** 从零做一个新 App（我的预设，D-609）。 */
  | { kind: 'new' }
  /** 改整个工作区（主页和所有 App）。 */
  | { kind: 'setup' }
  /** 改一个装好的 App；page：从这个 App 的哪一页进来的（AI 页的上下文）。 */
  | { kind: 'app'; app: string; page?: { id: string; title: string } };

export interface HandoffOptions {
  /** App 文件作为附件一起发；false 时 App 文件写在这条消息的最后（没有原生分享时的退路）。 */
  attached: boolean;
  /** 检查器也作为附件一起发（App 里打包了它的时候）。 */
  checker?: boolean;
  /** 附件里 App 文件的名字。 */
  fileName?: string;
  /** 打包在本机的指南和 patterns 也附上了。 */
  docs?: boolean;
  /** 用户在输入框里主动写下、点分享交给所选 App 的一句话。 */
  request?: string;
}

/** 网址带当天日期（?v=YYYYMMDD），让 AI 不用前几天缓存的旧版。 */
function docsLinks(now: Date) {
  const v = localDateStamp(now);
  return {
    guide: `${AGENT_DOCS_URL}tinkrum-app-guide.md?v=${v}`,
    patterns: `${AGENT_DOCS_URL}tinkrum-app-patterns.md?v=${v}`,
  };
}

/** 提示词存成这个文件一起分享：有的 App（Claude）收到多个文件时会丢掉分享的文字，文件不会丢。 */
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
    options.docs ? t(locale, 'handoffReadAttached') : t(locale, 'handoffRead', links),
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
