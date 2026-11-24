import {
  builtinText,
  describeParams,
  findWorkflowTarget,
  stepLabel,
  quickActionsOf,
  type Backdrop,
} from '@morph/core';
import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { t } from '../i18n';
import { onPicture } from './Backdrop';
import type { RenderEnv } from './components';
import { UiIcon } from './Icon';
import { IconButton } from './IconButton';
import { iconColors } from './theme';
import { Button, Card, IconTile } from './ui';

/**
 * workflowRunner component: displays workflow steps and opens the runner page upon tapping
 * "Start". Rendered as a small block in grids (adjacent running cards, or user grid/row
 * groupings) with the entire block tappable (D-108). Ignores position when look is specified:
 * card = card with "Run" button, row = single row with ▶ on the right, tile = small block
 * (D-230), icon = white-background button with icon only (D-449).
 */
export function WorkflowRunner({
  workflowId,
  look,
  backdrop,
  env,
}: {
  workflowId: string;
  look?: 'card' | 'row' | 'tile' | 'icon';
  /** Image background (D-258). */
  backdrop?: Backdrop | undefined;
  env: RenderEnv;
}) {
  const router = useRouter();
  const { locale, registry } = env;
  const palette = onPicture(env.palette, backdrop);
  // Can point to preset IDs of built-in quick actions; user-modified copies in config take precedence (D-259).
  const found = findWorkflowTarget(quickActionsOf(env.config), workflowId, locale);
  if (!found) return null;
  // Built-in quick action names follow the UI language (user-modified names are not replaced).
  const workflow = { ...found, name: builtinText(found.name, locale, registry) };
  const label = (s: { action: string; params: Record<string, unknown> }) =>
    stepLabel(registry.actions.get(s.action), s.params, locale) ?? s.action;
  // Key settings (e.g., "Under 500 KB"); runtime query parameters are excluded.
  const settings = workflow.steps
    .flatMap((s) => {
      const action = registry.actions.get(s.action);
      if (!action || action.input.length === 0) return [];
      const fixed = action.fields.map((f) => f.key).filter((k) => !s.ask?.includes(k));
      const text = describeParams(action, s.params, locale, new Date(), fixed);
      return text ? [text] : [];
    })
    .join(t(locale, 'separatorSemicolon'));
  const start = () => {
    if (env.locked) return env.locked();
    if (env.interactive)
      router.push({ pathname: '/run/[workflowId]', params: { workflowId: workflow.id } });
  };

  const shown = look ?? (env.inCell ? 'tile' : 'card');
  const icon =
    workflow.icon ?? (workflow.package && registry.tools.get(workflow.package)?.icon) ?? 'workflow';
  // Multi-step workflows (presets or custom) list their steps; single-function names already describe their purpose, so only fixed settings are listed.
  const detail =
    workflow.steps.length > 2
      ? workflow.steps
          .slice(1)
          .map((s) => label(s))
          .join(' → ')
      : settings;

  if (shown === 'icon') {
    return (
      <IconButton
        palette={palette}
        icon={icon}
        label={workflow.name}
        testID={`run-${workflow.id}`}
        onPress={start}
        onLongPress={env.onLongPress}
        column={env.cellColumn}
      />
    );
  }

  if (shown === 'row') {
    const play = iconColors(palette, 'tint');
    return (
      <Card
        palette={palette}
        backdrop={backdrop}
        testID={`run-${workflow.id}`}
        accessibilityLabel={workflow.name}
        onPress={start}
        onLongPress={env.onLongPress}>
        <View style={styles.row}>
          <IconTile palette={palette} icon={icon} size={40} {...iconColors(palette, 'tint')} />
          <View style={styles.rowText}>
            <Text numberOfLines={2} style={[palette.font('title', 16), { color: palette.text }]}>
              {workflow.name}
            </Text>
            {detail ? (
              <Text
                numberOfLines={2}
                style={[palette.font('body', 13), { color: palette.caption }]}>
                {detail}
              </Text>
            ) : null}
          </View>
          <View style={[styles.play, { backgroundColor: play.background }]}>
            <UiIcon name="play" size={18} color={play.color} />
          </View>
        </View>
      </Card>
    );
  }

  if (shown === 'tile') {
    return (
      <Card
        palette={palette}
        backdrop={backdrop}
        testID={`run-${workflow.id}`}
        accessibilityLabel={workflow.name}
        onPress={start}
        onLongPress={env.onLongPress}
        style={styles.tile}>
        <IconTile palette={palette} icon={icon} size={40} {...iconColors(palette, 'tint')} />
        {/* D-552: aligns names at the bottom of blocks: baselines of names in the same row are aligned, preventing empty space below single-line names. */}
        <View style={styles.tileText}>
          {/* Shrinks font size slightly instead of truncating when names cannot fit in two lines (French names are longer, D-487). */}
          <Text
            numberOfLines={2}
            adjustsFontSizeToFit
            minimumFontScale={0.8}
            style={[palette.font('title', 15), { color: palette.text }]}>
            {workflow.name}
          </Text>
          {/*
           * D-487: multi-step quick actions (scan to PDF, merge files, etc.) display only an icon
           * and name on their blocks because step chains are long and similar; single-function
           * actions (compress photos, etc.) retain fixed settings since their names are
           * incomplete.
           */}
          {workflow.steps.length <= 2 && settings ? (
            <Text numberOfLines={2} style={[palette.font('body', 12), { color: palette.caption }]}>
              {settings}
            </Text>
          ) : null}
        </View>
      </Card>
    );
  }

  return (
    <Card palette={palette} backdrop={backdrop} onLongPress={env.onLongPress}>
      <Text style={[palette.font('title', 17), { color: palette.text }]}>{workflow.name}</Text>
      <View style={styles.steps}>
        {workflow.steps.map((s, i) => (
          <Text
            key={s.id}
            testID={`step-${s.id}`}
            style={[palette.font('body', 14), { color: palette.muted }]}>
            {`${i > 0 ? '→ ' : ''}${label(s)}`}
          </Text>
        ))}
      </View>
      {settings ? (
        <Text style={[palette.font('body', 13), { color: palette.caption }]}>{settings}</Text>
      ) : null}
      <Button
        palette={palette}
        testID={`run-${workflow.id}`}
        label={t(locale, 'run')}
        onPress={start}
        onLongPress={env.onLongPress}
        style={styles.run}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  steps: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 6, rowGap: 2 },
  run: { marginTop: 6 },
  // Icon with up to two lines of text, occupying approximately 124pt: ensures blocks in the same row have equal height (D-487).
  tile: { flex: 1, minHeight: 132, justifyContent: 'space-between' },
  tileText: { gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowText: { flex: 1, gap: 2 },
  play: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});
