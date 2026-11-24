import { DEFAULT_THEME, resolveColors, t, type Locale, type StringKey } from '@morph/core';
import Constants from 'expo-constants';
import { useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';

import { formatWhen } from '../i18n';

// Rescue screen (Diagnostics 6.6): System layer, hardcoded in code (Invariant 8), does not read
// config, uses no renderer or theme—since those might be the broken part. Colors use default style,
// fonts use system fonts.

export interface RescueActions {
  /** Export a complete backup and open the share sheet. */
  exportBackup(): Promise<void>;
  /** Revert to the previous version; returns the timestamp/version of the current state being used. */
  stepBack(): Promise<number>;
  /** Hand error information over to the system share sheet, letting the user decide whether to send it. */
  shareError(text: string): Promise<void>;
  openSite(): Promise<void>;
}

type Busy = 'export' | 'back' | null;

export function RescueScreen({
  locale,
  error,
  version = Constants.expoConfig?.version ?? null,
  actions,
  onContinue,
}: {
  locale: Locale;
  error?: string;
  version?: string | null;
  actions: RescueActions;
  onContinue: () => void;
}) {
  const c = resolveColors(DEFAULT_THEME, useColorScheme() === 'dark');
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (kind: Exclude<Busy, null>, work: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(kind);
    setMessage(null);
    try {
      setMessage(await work());
    } catch (e) {
      const noOlder = e instanceof Error && e.message === 'noOlder';
      setMessage(
        t(
          locale,
          kind === 'export'
            ? 'rescueExportFailed'
            : noOlder
              ? 'rescueNoOlder'
              : 'rescueStepBackFailed',
        ),
      );
    } finally {
      setBusy(null);
    }
  };
  const versionText = t(locale, 'rescueVersion', { version: version ?? '?' });
  const button = (
    testID: string,
    label: StringKey,
    onPress: () => void,
    primary = false,
    spinning = false,
  ) => (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { borderColor: c.border, opacity: pressed ? 0.6 : 1 },
        primary && { backgroundColor: c.primary, borderColor: c.primary },
      ]}>
      {spinning ? (
        <ActivityIndicator color={primary ? c.onPrimary : c.text} />
      ) : (
        <Text style={[styles.label, { color: primary ? c.onPrimary : c.text }]}>
          {t(locale, label)}
        </Text>
      )}
    </Pressable>
  );

  return (
    <ScrollView
      testID="rescue"
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.page}>
      <Text accessibilityRole="header" style={[styles.title, { color: c.text }]}>
        {t(locale, 'rescueTitle')}
      </Text>
      <Text style={[styles.body, { color: c.muted }]}>{t(locale, 'rescueBody')}</Text>
      {button('rescue-continue', 'rescueContinue', onContinue, true)}
      {button(
        'rescue-step-back',
        'rescueStepBack',
        () =>
          void run('back', async () =>
            t(locale, 'rescueSteppedBack', {
              when: formatWhen(locale, new Date(await actions.stepBack()), new Date()),
            }),
          ),
        false,
        busy === 'back',
      )}
      {button(
        'rescue-export',
        'rescueExport',
        () =>
          void run('export', async () => {
            await actions.exportBackup();
            return null;
          }),
        false,
        busy === 'export',
      )}
      {button('rescue-site', 'rescueSite', () => void actions.openSite().catch(() => undefined))}
      {message ? (
        <Text testID="rescue-message" style={[styles.body, { color: c.text }]}>
          {message}
        </Text>
      ) : null}
      <View style={[styles.rule, { backgroundColor: c.border }]} />
      <Text testID="rescue-version" style={[styles.small, { color: c.caption }]}>
        {versionText}
      </Text>
      {error ? (
        <>
          <Text testID="rescue-error" selectable style={[styles.error, { color: c.caption }]}>
            {error}
          </Text>
          {button(
            'rescue-share-error',
            'rescueShareError',
            () =>
              void actions
                .shareError(`${versionText} · ${Platform.OS} ${Platform.Version}\n\n${error}`)
                .catch(() => undefined),
          )}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 24, paddingTop: 72, gap: 14 },
  title: { fontSize: 24, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 22 },
  button: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    justifyContent: 'center',
  },
  label: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
  small: { fontSize: 13 },
  error: { fontSize: 12, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
});
