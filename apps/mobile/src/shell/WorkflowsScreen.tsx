import {
  builtInWorkflows,
  type Locale,
  localize,
  presetById,
  QUICK_ACTION_CATEGORIES,
  QUICK_ACTION_KINDS,
  type QuickActionKind,
  quickActionsOf,
  type Registry,
  shareFit,
  type Workflow,
  workflowKinds,
  stepLabel,
} from '@morph/core';

import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { t } from '../i18n';
import { usePacks } from '../packs/PackHost';
import { UiIcon, type UiIconName } from '../renderer/Icon';
import { mimeOf } from '../runtime/actions/helpers';
import { useIncoming, releaseShare } from '../share/incoming';
import type { SucceededRuns } from '../storage/types';
import type { Palette } from '../renderer/theme';
import { Button, Card, ListRow, PageTitle } from '../renderer/ui';
import { runsHere } from '../runtime/device-support';
import { packsNeeded } from '../runtime/runner';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import { Banner } from './Banner';

/** Steps chained into a single line: "Select photo -> Passport photo -> Rename". */
export function stepChain(wf: Pick<Workflow, 'steps'>, registry: Registry, locale: Locale): string {
  return wf.steps
    .map((s) => stepLabel(registry.actions.get(s.action), s.params, locale) ?? s.action)
    .join(' → ');
}

/**
 * Quick action category page: shows own quick actions first, followed by all quick actions in
 * this category, with frequently used and recently used ones appearing at the top. Provided by
 * the core (AI cannot modify this page); built-in quick actions do not need to be added and can
 * be run directly (D-236). inPage: displayed as a quickActionList component on a page (D-230),
 * non-scrolling, without a toast bar; guard returns true to ignore taps (draft, preview).
 */
export function WorkflowsScreen({
  palette,
  locale,
  registry,
  kind,
  shared,
  embedded = false,
  inPage,
}: {
  palette: Palette;
  locale: Locale;
  registry: Registry;
  kind?: QuickActionKind;
  shared?: string;
  embedded?: boolean;
  inPage?: { title?: string; guard: () => boolean };
}) {
  const router = useRouter();
  const config = useWorkspace((s) => s.config)!;
  const { files, repo } = useWorkspaceContext();
  const incoming = useIncoming((s) => s.share);
  const share = shared && String(incoming?.id) === shared ? incoming : null;
  const handed = useRef(false);
  useEffect(
    () => () => {
      if (shared && !handed.current) void releaseShare(files, Number(shared));
    },
    [files, shared],
  );
  const [usage, setUsage] = useState<SucceededRuns>(new Map());
  // Already installed packs, including those bundled with the App (D-510): built-ins using them no longer state "Requires download for first use". Left blank until loaded.
  const packs = usePacks();
  const [havePacks, setHavePacks] = useState<ReadonlySet<string> | null>(packs ? null : new Set());
  useEffect(() => {
    if (!packs) return;
    let alive = true;
    void packs.store
      .installed()
      .then((list) => alive && setHavePacks(new Set(list.map((p) => p.id))))
      .catch(() => alive && setHavePacks(new Set()));
    return () => {
      alive = false;
    };
  }, [packs]);
  useFocusEffect(
    useCallback(() => {
      handed.current = false;
      let alive = true;
      void repo
        .countSucceededRuns()
        .then((counts) => {
          if (alive) setUsage(counts);
        })
        .catch(() => {
          /* Allows browsing categories even when statistics are temporarily unavailable. */
        });
      return () => {
        alive = false;
      };
    }, [repo]),
  );
  const inCategory = (w: Workflow) => !kind || workflowKinds(w).includes(kind);
  const builtIn = builtInWorkflows(quickActionsOf(config), locale);
  // Unused items ordered by: own, built-in, tool-provided.
  const all = [
    ...quickActionsOf(config).filter((w) => !w.package),
    ...builtIn,
    ...quickActionsOf(config).filter((w) => w.package),
  ]
    .filter((w) => inCategory(w) && runsHere(w))
    .sort((a, b) => {
      const x = usage.get(a.id),
        y = usage.get(b.id);
      return (y?.count ?? 0) - (x?.count ?? 0) || (y?.lastAt ?? 0) - (x?.lastAt ?? 0);
    });
  const fit = (w: Workflow) =>
    share
      ? shareFit(
          w,
          share.files.map((f) => ({ ...f, mimeType: mimeOf(f.name, f.mimeType) })),
        )
      : { ok: true as const };
  const fits = (w: Workflow) => fit(w).ok;
  const fitMessage = (w: Workflow) => {
    const result = fit(w);
    if (result.ok) return '';
    if (result.reason === 'tooFew')
      return t(locale, 'WorkflowsScreen_Needs_at_least_files_0ed9b', { v0: result.min });
    if (result.reason === 'tooMany')
      return t(locale, 'WorkflowsScreen_Takes_at_most_files_0fe59', { v0: result.max });
    return t(locale, 'WorkflowsScreen_Cannot_use_these_files_d0ca3');
  };
  const caption = [palette.font('body', 13), { color: palette.muted }];

  const blocked = () => inPage?.guard() ?? false;
  const run = (wf: Workflow) => {
    if (!fits(wf) || (shared && !share) || blocked()) return;
    handed.current = true;
    const route = {
      pathname: '/run/[workflowId]' as const,
      params: { workflowId: wf.id, ...(shared ? { shared } : {}) },
    };
    if (shared) router.replace(route);
    else router.push(route);
  };
  const edit = (wf: Workflow) => {
    if (!blocked()) router.push({ pathname: '/workflow/[id]', params: { id: wf.id } });
  };
  const row = (wf: Workflow) => {
    const preset = builtIn.includes(wf) ? presetById(wf.preset!) : undefined;
    const toolName = wf.package
      ? (localize(registry.tools.get(wf.package)?.name, locale) ?? wf.package)
      : undefined;
    // Built-in items have a description sentence, so steps are not listed (the steps are already covered in the description).
    const description = preset && localize(preset.description, locale);
    // iOS uses system recognition and scanning, so scanning and OCR packs are not needed (D-084).
    const needsDownload =
      preset &&
      havePacks !== null &&
      packsNeeded(preset.packs ?? [], files).some((id) => !havePacks.has(id));
    return (
      <Card key={wf.id} palette={palette} testID={`workflow-${wf.id}`}>
        <View style={styles.cardRow}>
          <View style={styles.cardText}>
            <Text style={[palette.font('title', 16), { color: palette.text }]}>{wf.name}</Text>
            {toolName ? <Text style={caption}>{toolName}</Text> : null}
            <Text style={caption}>{description || stepChain(wf, registry, locale)}</Text>
            {needsDownload ? (
              <Text style={caption}>
                {t(locale, 'WorkflowsScreen_The_first_run_downloads_what_it_needs__3a8fa')}
              </Text>
            ) : null}
            {usage.has(wf.id) ? (
              <Text style={caption}>{t(locale, 'shareUsed', { n: usage.get(wf.id)!.count })}</Text>
            ) : null}
            {share && !fits(wf) ? <Text style={caption}>{fitMessage(wf)}</Text> : null}
          </View>
          <View style={styles.actions}>
            <IconAction
              palette={palette}
              icon="play"
              testID={`workflow-run-${wf.id}`}
              label={t(locale, 'WorkflowsScreen_Run_5cab2')}
              disabled={!fits(wf)}
              onPress={() => run(wf)}
            />
            <IconAction
              palette={palette}
              icon="edit"
              testID={`workflow-edit-${wf.id}`}
              label={t(locale, 'WorkflowsScreen_Edit_ef7c8')}
              onPress={() => edit(wf)}
            />
          </View>
        </View>
      </Card>
    );
  };

  if (shared && !share) return <Text style={caption}>{t(locale, 'shareGone')}</Text>;

  if (!kind)
    return (
      <Body
        palette={palette}
        inPage={inPage}
        testID="workflows-screen"
        gap={inPage ? palette.gap - 4 : palette.gap}>
        {/* The page stack header already has a title, so it is not repeated; no header when embedded in the main interface. */}
        {inPage ? null : embedded ? (
          <PageTitle palette={palette}>
            {t(locale, 'WorkflowsScreen_What_Morph_can_do_8f4f4')}
          </PageTitle>
        ) : (
          <Banner palette={palette} />
        )}
        {QUICK_ACTION_KINDS.map((category) => (
          <ListRow
            key={category}
            palette={palette}
            testID={`category-${category}`}
            icon={QUICK_ACTION_CATEGORIES[category].icon}
            label={localize(QUICK_ACTION_CATEGORIES[category].name, locale)}
            onPress={() => {
              if (blocked()) return;
              handed.current = true;
              const route = {
                pathname: '/quick-actions/[kind]' as const,
                params: { kind: category, ...(shared ? { shared } : {}) },
              };
              if (shared) router.replace(route);
              else router.push(route);
            }}
          />
        ))}
      </Body>
    );

  return (
    <Body palette={palette} inPage={inPage} testID={`quick-actions-${kind}`} gap={palette.gap - 4}>
      {/* The category page is always in the page stack and its header already displays the category name. */}
      {embedded || inPage ? null : <Banner palette={palette} />}
      <Button
        palette={palette}
        testID="quick-actions-create"
        label={t(locale, 'WorkflowsScreen_Make_your_own_quick_action_8bc98')}
        onPress={() => {
          if (blocked()) return;
          handed.current = true;
          router.push({
            pathname: '/change',
            params: {
              text: localize(QUICK_ACTION_CATEGORIES[kind].prefill, locale),
              ...(shared ? { shared } : {}),
            },
          });
        }}
      />
      {all.map(row)}
    </Body>
  );
}

/** Page components do not scroll and have no toast bar (the page has its own); title is determined by the AI. */
function Body({
  palette,
  inPage,
  testID,
  gap,
  children,
}: {
  palette: Palette;
  inPage: { title?: string } | undefined;
  testID: string;
  gap: number;
  children: ReactNode;
}) {
  if (inPage)
    return (
      <View testID={testID} style={{ gap }}>
        {inPage.title ? (
          <Text style={[palette.font('title', 18), { color: palette.text }]}>{inPage.title}</Text>
        ) : null}
        {children}
      </View>
    );
  return (
    <ScrollView
      testID={testID}
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={{ padding: palette.pad, gap, paddingBottom: 48 }}>
      {children}
    </ScrollView>
  );
}

/** Circular icon button on the right side of the card (run, edit); text is reserved for screen readers. */
function IconAction({
  palette,
  icon,
  label,
  testID,
  disabled = false,
  onPress,
}: {
  palette: Palette;
  icon: UiIconName;
  label: string;
  testID: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconAction,
        { backgroundColor: palette.primaryTint, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
      ]}>
      <UiIcon name={icon} size={18} color={palette.primaryText} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardText: { flex: 1, gap: 4 },
  actions: { flexDirection: 'row', gap: 8 },
  iconAction: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
