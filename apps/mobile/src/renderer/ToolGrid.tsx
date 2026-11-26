import {
  builtinText,
  localize,
  pageTarget,
  toolGridToolIds,
  type BlockOf,
  type Page,
} from '@morph/core';

import { Alert, StyleSheet, Text, View } from 'react-native';

import { t } from '../i18n';
import { useWorkspace } from '../workspace/context';
import type { RenderEnv } from './components';
import { Icon } from './Icon';
import { iconColors, onPage } from './theme';
import { Card, IconTile } from './ui';

const COLUMNS = 3;

/**
 * toolGrid component (D-181): small icons for a group of tools, three per row. Tapping opens a
 * tool; unadded tool icons appear dimmed with a "+" badge, and tapping them adds and immediately
 * opens them (same behavior as the tool directory without a confirmation dialog, undoable via
 * toast banner, D-105).
 */
export function ToolGrid({
  grid,
  ids: listed,
  page,
  env,
}: {
  grid: BlockOf<'catalog'>;
  /** source.ids of the packages grid. */
  ids: readonly string[] | undefined;
  page: Page | undefined;
  env: RenderEnv;
}) {
  const { palette, locale, registry, config } = env;
  const proposeOps = useWorkspace((s) => s.proposeOps);
  const confirm = useWorkspace((s) => s.confirm);
  const catalog = [...registry.tools.keys()];
  const ids = page
    ? toolGridToolIds({ ids: listed }, page, catalog)
    : (listed ?? catalog).filter((id) => registry.tools.has(id));
  if (ids.length === 0) return null;

  async function open(toolId: string) {
    const installed = config.packages.find((x) => x.id === toolId);
    if (installed) {
      env.navigate(pageTarget(installed.page));
      return;
    }
    const def = registry.tools.get(toolId)!;
    const name = localize(def.name, locale);
    const result = await proposeOps(
      [{ op: 'setPackage', package: toolId, do: 'add' }],
      t(locale, 'installSummary', { name }),
    );
    if (result.kind !== 'preview') {
      Alert.alert(
        t(locale, 'invalidPlan'),
        result.kind === 'invalid' ? result.issues.join('\n') : result.message,
      );
      return;
    }
    await confirm();
    env.navigate(pageTarget(def.createPage(locale).id));
  }

  const rows: string[][] = [];
  for (let i = 0; i < ids.length; i += COLUMNS) rows.push(ids.slice(i, i + COLUMNS));
  const gap = palette.gap - 6;

  return (
    <View style={{ gap: 10 }}>
      {grid.show?.title ? (
        <Text
          style={[
            palette.font('bodyBold', 12),
            { color: onPage(palette).caption, letterSpacing: 0.5 },
            grid.style?.align === 'center' && styles.textCenter,
          ]}>
          {grid.show.title.toUpperCase()}
        </Text>
      ) : null}
      {rows.map((row, r) => (
        <View key={r} style={[styles.row, { gap }]}>
          {row.map((toolId) => {
            const def = registry.tools.get(toolId)!;
            const installed = config.packages.find((x) => x.id === toolId);
            // Uses the page name if the tool page has been renamed (same as tool cards).
            const pageTitle =
              installed && config.containers.pages.find((p) => p.id === installed.page)?.title;
            const name = pageTitle
              ? builtinText(pageTitle, locale, registry)
              : localize(def.name, locale);
            return (
              <Card
                key={toolId}
                palette={palette}
                testID={`toolgrid-${toolId}`}
                accessibilityLabel={installed ? name : `${t(locale, 'install')} ${name}`}
                onPress={env.interactive ? () => void open(toolId) : undefined}
                onLongPress={env.onLongPress}
                style={styles.tile}>
                <View>
                  <IconTile
                    palette={palette}
                    icon={def.icon}
                    size={40}
                    {...(installed
                      ? iconColors(palette, 'tint')
                      : { background: palette.border, color: palette.caption })}
                  />
                  {installed ? null : (
                    <View
                      testID={`toolgrid-add-${toolId}`}
                      style={[styles.badge, { backgroundColor: palette.primary }]}>
                      <Icon name="plus" size={11} color={palette.onPrimary} />
                    </View>
                  )}
                </View>
                <Text
                  numberOfLines={2}
                  style={[
                    palette.font('title', 13),
                    styles.textCenter,
                    { color: installed ? palette.text : palette.muted },
                  ]}>
                  {name}
                </Text>
              </Card>
            );
          })}
          {Array.from({ length: COLUMNS - row.length }, (_, i) => (
            <View key={`empty-${i}`} style={styles.cell} />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'stretch' },
  cell: { flex: 1 },
  tile: { flex: 1, alignItems: 'center', paddingHorizontal: 6, paddingVertical: 12 },
  textCenter: { textAlign: 'center' },
  badge: {
    position: 'absolute',
    top: -4,
    right: -6,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
