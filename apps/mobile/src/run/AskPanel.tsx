import {
  localize,
  renderNameTemplate,
  sanitizeFileName,
  type AskRequest,
  type Locale,
  type RunValue,
  isFileValue,
} from '@morph/core';

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Dialog } from '../renderer/Overlays';
import { t } from '../i18n';
import type { Palette } from '../renderer/theme';
import { ParamForm, againKey } from './ParamForm';

// Runtime parameter prompt (workflow step ask). File name template displays as a rendered name, while the user edits the final name.

function suggestedName(template: string, input: RunValue | null, now: Date): string {
  const first = isFileValue(input) ? input.items[0] : undefined;
  return renderNameTemplate(template, {
    now,
    index: 1,
    sourceName: first?.name ?? '',
    ...(first?.takenAt !== undefined ? { takenAt: new Date(first.takenAt) } : {}),
  });
}

export function initialAnswers(request: AskRequest, now: Date): Record<string, unknown> {
  const values: Record<string, unknown> = { ...request.params };
  for (const field of request.action.fields) {
    if (field.kind === 'nameTemplate' && request.keys.includes(field.key)) {
      values[field.key] = suggestedName(String(request.params[field.key]), request.input, now);
    }
  }
  return values;
}

export function AskPanel({
  request,
  palette,
  locale,
  now,
  onAnswer,
  okLabel,
}: {
  request: AskRequest;
  palette: Palette;
  locale: Locale;
  now: Date;
  onAnswer: (values: Record<string, unknown> | null) => void;
  /** Confirm button text ("Apply" in the file room tool panel, D-360). */
  okLabel?: string;
}) {
  const [values, setValues] = useState(() => initialAnswers(request, now));
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const answers: Record<string, unknown> = {};
    const secrets: Record<string, unknown> = {};
    for (const key of request.keys) {
      const field = request.action.fields.find((f) => f.key === key);
      let value = values[key];
      // Passwords are not in the parameter structure; passed back separately (D-194). When required twice, both entries must match.
      if (field?.kind === 'secret') {
        if (field.confirm && value !== values[againKey(key)]) {
          return setError(t(locale, 'askPasswordMismatch'));
        }
        secrets[key] = value;
        continue;
      }
      // User inputs the final file name, not a template: strip curly braces, sanitize according to file naming rules.
      if (field?.kind === 'nameTemplate') {
        const literal = String(value ?? '')
          .replace(/[{}]/g, '')
          .trim();
        if (!literal)
          return setError(t(locale, 'askInvalid', { detail: localize(field.label, locale) }));
        value = sanitizeFileName(literal);
      }
      answers[key] = value;
    }
    const parsed = request.action.params.safeParse({ ...request.params, ...answers });
    if (!parsed.success) {
      const labels = parsed.error.issues.map((i) => {
        const key = String(i.path[0] ?? '');
        return (
          localize(request.action.fields.find((f) => f.key === key)?.label, locale) ?? i.message
        );
      });
      setError(
        t(locale, 'askInvalid', {
          detail: [...new Set(labels)].join(t(locale, 'separatorList')),
        }),
      );
      return;
    }
    onAnswer({ ...answers, ...secrets });
  }

  const onlyName =
    request.keys.length === 1 &&
    request.action.fields.find((f) => f.key === request.keys[0])?.kind === 'nameTemplate';

  return (
    <Dialog
      palette={palette}
      locale={locale}
      visible
      animationType="fade"
      onClose={() => onAnswer(null)}
      backdropLabel={t(locale, 'close')}
      style={[styles.dialog, { backgroundColor: palette.surface, borderRadius: palette.radius }]}>
      <Text style={[palette.font('title', 18), { color: palette.text }]}>
        {onlyName ? t(locale, 'askName') : localize(request.action.label, locale)}
      </Text>
      {/* When parameter prompts are numerous (e.g., ID photo specs have over a dozen), making it taller than the screen: scroll in the middle, keeping the title and "Confirm" always visible. */}
      <ScrollView testID="ask-scroll" style={styles.scroll} keyboardShouldPersistTaps="handled">
        <ParamForm
          action={request.action}
          values={values}
          onChange={(v) => {
            setValues(v);
            setError(null);
          }}
          palette={palette}
          locale={locale}
          only={request.keys}
          testPrefix="ask"
          hideLabels={onlyName}
        />
      </ScrollView>
      {error ? (
        <Text
          testID="ask-error"
          style={[palette.font('bodyMedium', 14), { color: palette.danger }]}>
          {error}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Pressable testID="prompt-cancel" onPress={() => onAnswer(null)} hitSlop={8}>
          <Text style={[palette.font('bodyBold', 16), { color: palette.muted }]}>
            {t(locale, 'cancel')}
          </Text>
        </Pressable>
        <Pressable testID="prompt-ok" onPress={submit} hitSlop={8}>
          <Text style={[palette.font('bodyBold', 16), { color: palette.primaryText }]}>
            {okLabel ?? t(locale, 'ok')}
          </Text>
        </Pressable>
      </View>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  dialog: { padding: 22, gap: 18, maxHeight: '100%' },
  scroll: { flexGrow: 0, flexShrink: 1 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 24 },
});
