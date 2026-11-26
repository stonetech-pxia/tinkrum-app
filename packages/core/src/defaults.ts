import { t } from './messages';
import {
  CURRENT_SCHEMA_VERSION,
  HOME_PAGE_ID,
  pageTarget,
  type IconName,
  type Locale,
  type Localized,
  type SystemTarget,
  type WorkspaceConfig,
} from './schema';
import { FILES_TABLE } from './files-table';
import { DEFAULT_THEME } from './theme';

export const SYSTEM_TARGET_LABELS: Record<SystemTarget, Localized> = {
  quickActions: {
    en: 'What Tinkrum can do',
    zh: 'Tinkrum 可以做什么',
    fr: 'Ce que Tinkrum peut faire',
  },
  tools: { en: 'Tools', zh: '工具', fr: 'Outils' },
  ai: { en: 'Tink', zh: 'Tink', fr: 'Tink' },
  history: { en: 'Changes', zh: '改动记录', fr: 'Modifications' },
  settings: { en: 'Settings', zh: '设置', fr: 'Paramètres' },
};

/** `tink` is Tink's small hammer icon (D-436), used exclusively for this entry point and not included in the whitelist of icons allowed in the configuration. */
export const SYSTEM_TARGET_ICONS: Record<SystemTarget, IconName | 'tink'> = {
  quickActions: 'workflow',
  tools: 'apps',
  ai: 'tink',
  history: 'history',
  settings: 'settings',
};

/** Default workspace written on first startup (revision 1). */
export function createDefaultWorkspace(locale: Locale): WorkspaceConfig {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    theme: JSON.parse(JSON.stringify(DEFAULT_THEME)) as WorkspaceConfig['theme'],
    nav: {
      bar: [pageTarget(HOME_PAGE_ID), 'tools', 'ai', 'history', 'settings'],
      floating: [],
    },
    data: { tables: [] },
    containers: {
      pages: [
        {
          id: HOME_PAGE_ID,
          title: t(locale, 'defaults_Home_ec133'),
          icon: 'home',
          blocks: [
            {
              id: 'welcome',
              look: 'header',
              show: {
                title: t(locale, 'defaults_My_workspace_df4a5'),
                subtitle: t(locale, 'defaults_Tap_AI_and_describe_how_this_app_shoul_7d958'),
              },
            },
            // "Add Tool": primary-colored title, plus sign, large block (formerly catalogLink, M7).
            {
              id: 'catalog',
              look: 'button',
              show: {
                label: t(locale, 'defaults_Add_tools_9c8e1'),
                icon: 'plus',
                shape: 'tile',
                accent: true,
              },
              opens: 'tools',
            },
            // Recent files: user files that are not images (formerly fileList without mimeType).
            {
              id: 'recent-files',
              look: 'files',
              show: { title: t(locale, 'defaults_Recent_files_2d602') },
              source: {
                table: FILES_TABLE,
                filter: [{ field: 'kind', op: 'isNot', value: 'image' }],
                limit: 5,
              },
            },
          ],
        },
      ],
    },
    tools: [],
    packages: [],
  };
}
