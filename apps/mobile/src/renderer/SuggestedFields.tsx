import {
  visibleFormSections,
  type Collection,
  type FieldIssue,
  type Locale,
  type PrefillEngine,
  type TextPage,
} from '@morph/core';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Text, View } from 'react-native';

import { useFieldSuggestions } from '../data/field-suggestions';
import { t } from '../i18n';
import { PackGate } from '../packs/PackGate';
import { usePacks } from '../packs/PackHost';
import { useCalendar } from '../workspace/context';
import { FieldsForm, suggestionFormValue } from './data';
import type { Palette } from './theme';
import { Pill } from './ui';

// Fields for new entry forms (D-394, D-397): entry pages and quick action "Log an expense" share
// the same configuration. Photos and PDFs in attachments are read automatically by the form to
// provide suggestions for each empty field, which are filled only when tapped; quick action steps
// do not require recognizing text. Skipped when the form disables readAttachments. D-570: fields
// are rendered in sections according to the form configuration, with conditional sections showing
// or hiding based current form values (updating dynamically as the user types); values in hidden
// sections are not cleared. D-575: when a quick action receives a spoken sentence from the user
// (heard), suggestions are derived from it; high-confidence values are directly filled into fields
// the user hasn't touched yet, accompanied by "Filled based on your input"; low-confidence items
// remain as suggestions. Saving still requires the user to tap "Save".

export function SuggestedFields({
  suggest: enabled,
  collection,
  values,
  onChange,
  issues,
  palette,
  locale,
  testPrefix,
  related,
  engine,
  onPages,
  heard,
}: {
  /** Suggestions are provided only for new entry forms (not when editing existing entries). */
  suggest: boolean;
  collection: Collection;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  issues: FieldIssue[];
  palette: Palette;
  locale: Locale;
  testPrefix: string;
  related?: ComponentProps<typeof FieldsForm>['related'];
  /** New entry form page (D-444): suggestions rely solely on rules and recalculate whenever a field changes, without reloading the model on each change. */
  engine?: PrefillEngine;
  onPages?: (pages: TextPage[]) => void;
  /** Spoken text provided by the user for this entry (D-575). */
  heard?: string | undefined;
}) {
  const packs = usePacks();
  const cal = useCalendar();
  const sections = visibleFormSections(collection, values, new Date(), cal);
  const suggest = useFieldSuggestions({
    enabled,
    collection,
    values,
    locale,
    ...(engine ? { engine } : {}),
    ...(onPages ? { onPages } : {}),
    heard,
  });
  // Fields with high confidence that the user has not touched (via typing or tapping suggestions): directly filled with values. Fields that are auto-filled display a hint line, which disappears once the user modifies them.
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const sure: Record<string, unknown> = {};
  if (enabled && heard !== undefined) {
    for (const [id, list] of Object.entries(suggest.suggestions)) {
      const field = collection.fields.find((f) => f.id === id);
      if (list[0]?.sure && field && !touched.has(id))
        sure[id] = suggestionFormValue(field, list[0].value);
    }
  }
  const filled = new Set(Object.keys(sure).filter((id) => values[id] === sure[id]));
  const latest = useRef({ values, onChange });
  useEffect(() => {
    latest.current = { values, onChange };
  });
  const pending = Object.keys(sure).filter((id) => values[id] !== sure[id]);
  const pendingKey = pending.map((id) => `${id}=${String(sure[id])}`).join('|');
  useEffect(() => {
    if (!pendingKey) return;
    const { values: now, onChange: change } = latest.current;
    const next = { ...now };
    for (const part of pendingKey.split('|')) {
      const id = part.slice(0, part.indexOf('='));
      const field = collection.fields.find((f) => f.id === id);
      const top = suggest.suggestions[id]?.[0];
      if (field && top) next[id] = suggestionFormValue(field, top.value);
    }
    change(next);
  }, [pendingKey, collection, suggest.suggestions]);
  const edit = (next: Record<string, unknown>) => {
    const changed = collection.fields.filter((f) => next[f.id] !== values[f.id]).map((f) => f.id);
    if (changed.length > 0) setTouched((prev) => new Set([...prev, ...changed]));
    onChange(next);
  };
  return (
    <>
      {suggest.missing.length > 0 && packs ? (
        <View testID="suggestions-notice" style={{ gap: 8, alignItems: 'flex-start' }}>
          <Text style={[palette.font('body', 14), { color: palette.muted }]}>
            {t(locale, 'suggestionsNeedDownload')}
          </Text>
          <Pill
            palette={palette}
            testID="suggestions-download"
            label={t(locale, 'suggestionsDownload')}
            onPress={suggest.ask}
          />
        </View>
      ) : null}
      {suggest.working ? (
        <Text
          testID="suggestions-working"
          style={[palette.font('body', 13), { color: palette.caption }]}>
          {t(locale, 'suggestionsWorking')}
        </Text>
      ) : null}
      {sections.map((section) => (
        <View
          key={section.index ?? 'rest'}
          testID={`${testPrefix}-section-${section.index ?? 'rest'}`}
          style={{ gap: 12 }}>
          {section.title !== undefined ? (
            <Text
              accessibilityRole="header"
              style={[palette.font('bodyBold', 15), { color: palette.text }]}>
              {section.title}
            </Text>
          ) : null}
          <FieldsForm
            collection={collection}
            fieldIds={section.fields}
            values={values}
            onChange={edit}
            {...(enabled ? { suggestions: suggest.suggestions } : {})}
            onSuggestion={suggest.remember}
            heard={filled}
            issues={issues}
            palette={palette}
            locale={locale}
            testPrefix={testPrefix}
            {...(related !== undefined ? { related } : {})}
          />
        </View>
      ))}
      {suggest.asking && packs ? (
        <PackGate
          needs={suggest.asking}
          store={packs.store}
          palette={palette}
          locale={locale}
          onDone={suggest.answered}
        />
      ) : null}
    </>
  );
}
