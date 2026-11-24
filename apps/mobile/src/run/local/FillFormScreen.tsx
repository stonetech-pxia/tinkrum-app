import { canEncodeStandardText } from '@morph/tool-pdf';
import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { Pill } from '../../renderer/ui';
import { t } from '../../i18n';

import type { LocalScreenProps } from '../RunScreen';
import { LocalFrame } from './LocalFrame';

// Fill form (TOOLS_DESIGN §4 fillForm): generates inputs based on field type (text / checkbox /
// dropdown / radio / list). Returns only fields modified by the user; filled content is used solely
// for the current run, never enters configuration, and is never sent to the AI.

type Value = string | boolean;

/** Standard fonts in pdf-lib support only Latin alphabets (D-073); multiline text is checked line by line. */
const encodable = (text: string) => text.split(/\r\n|\r|\n/).every(canEncodeStandardText);

export function FillFormScreen({
  input,
  palette,
  locale,
  onDone,
  onCancel,
}: LocalScreenProps<'fillForm'>) {
  const fields = input.fields.filter((f) => !f.readOnly && f.type !== 'other');
  const [values, setValues] = useState<Record<string, Value>>({});
  const set = (name: string, value: Value) => setValues((v) => ({ ...v, [name]: value }));
  const valueOf = (name: string, fallback: Value | undefined) =>
    name in values ? values[name] : fallback;
  const bad = Object.entries(values).filter(([, v]) => typeof v === 'string' && !encodable(v));

  const input_ = [
    styles.input,
    palette.font('body', 16),
    {
      color: palette.text,
      borderColor: palette.border,
      borderRadius: palette.controlRadius,
      backgroundColor: palette.surface,
    },
  ];

  return (
    <LocalFrame
      palette={palette}
      title={t(locale, 'FillFormScreen_Fill_in_form_5d701')}
      cancelLabel={t(locale, 'cancel')}
      doneLabel={t(locale, 'localDone')}
      onCancel={onCancel}
      onDone={() => onDone(values)}
      doneDisabled={bad.length > 0}>
      <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
        <Text style={[palette.font('body', 14), { color: palette.muted }]}>
          {t(locale, 'FillFormScreen_has_fields_to_fill_in_Use_Latin_letter_e3442', {
            v0: input.item.name,
            v1: input.item.ext,
            v2: fields.length,
          })}
        </Text>
        {fields.map((field, i) => {
          const value = valueOf(field.name, field.value);
          const invalid = typeof value === 'string' && !encodable(value);
          return (
            <View key={field.name} style={styles.field} testID={`form-field-${i}`}>
              <Text style={[palette.font('bodyBold', 14), { color: palette.text }]}>
                {field.name}
              </Text>
              {field.type === 'text' ? (
                <TextInput
                  testID={`form-text-${i}`}
                  style={[input_, field.multiline ? styles.multiline : null]}
                  value={typeof value === 'string' ? value : ''}
                  onChangeText={(text) => set(field.name, text)}
                  multiline={field.multiline}
                  autoCorrect={false}
                />
              ) : field.type === 'checkbox' ? (
                <Switch
                  testID={`form-check-${i}`}
                  value={Boolean(value)}
                  onValueChange={(v) => set(field.name, v)}
                  trackColor={{ true: palette.primary }}
                />
              ) : (
                <View style={styles.wrap}>
                  {(field.options ?? []).map((option, j) => (
                    <Pill
                      key={option}
                      palette={palette}
                      testID={`form-option-${i}-${j}`}
                      label={option}
                      selected={value === option}
                      onPress={() => set(field.name, option)}
                    />
                  ))}
                </View>
              )}
              {invalid ? (
                <Text style={[palette.font('body', 13), { color: palette.danger }]}>
                  {t(locale, 'FillFormScreen_This_form_can_only_hold_Latin_letters__179fb')}
                </Text>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </LocalFrame>
  );
}

const styles = StyleSheet.create({
  list: { padding: 20, gap: 18 },
  field: { gap: 8 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: { borderWidth: 1.5, paddingHorizontal: 14, paddingVertical: 12 },
  multiline: { minHeight: 96, textAlignVertical: 'top' },
});
