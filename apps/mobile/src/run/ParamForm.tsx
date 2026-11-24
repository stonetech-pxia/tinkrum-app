import {
  localize,
  paramUnitLabel,
  type ActionDefinition,
  type Collection,
  type Locale,
  type ParamField,
} from '@morph/core';

import { StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { Pill } from '../renderer/ui';
import { t } from '../i18n';
import type { Palette } from '../renderer/theme';
import { useWorkspace } from '../workspace/context';

// Automatically generate a form based on the action's parameter schema metadata (action contract see packages/core/src/workflow/contract.ts). Shared by runtime prompts and workflow edit pages.

/** Password requiring two inputs; the second input is placed under this key (form-only, not exported). */
export const againKey = (key: string) => `${key}:again`;

export function visibleFields(
  action: ActionDefinition,
  values: Record<string, unknown>,
  only?: readonly string[],
): ParamField[] {
  // Passwords are asked only at runtime (D-194), hidden on the edit page.
  return action.fields.filter(
    (f) =>
      (only ? only.includes(f.key) : f.kind !== 'secret') &&
      (!f.showIf || f.showIf.equals.includes(values[f.showIf.key] as never)),
  );
}

export function ParamForm({
  action,
  values,
  onChange,
  palette,
  locale,
  only,
  testPrefix = 'param',
  hideLabels = false,
  collection,
}: {
  action: ActionDefinition;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  palette: Palette;
  locale: Locale;
  only?: readonly string[];
  testPrefix?: string;
  /** Hide labels when there is only a single parameter and the title already explains it. */
  hideLabels?: boolean;
  /** "Field" parameter chosen from this table (the table from the preceding "Read records" step in the workflow). */
  collection?: Collection | undefined;
}) {
  // Provide common specs during runtime prompting as well, filling only the requested parameters.
  const shown = visibleFields(action, values, only);
  const all = (action.presets ?? []).map((p) => ({
    ...p,
    values: only
      ? Object.fromEntries(Object.entries(p.values).filter(([k]) => only.includes(k)))
      : p.values,
  }));
  // Shares name with an option below and sets that option's specs (e.g., ID photo specs): button
  // and option are redundant, so hide it; instead, fill other parameters within the spec (such as
  // maximum ID photo size) together when selecting that option.
  const choiceFor = (p: (typeof all)[number]) =>
    shown.find(
      (f) =>
        f.kind === 'choice' &&
        f.key in p.values &&
        f.options?.some(
          (o) =>
            o.value === p.values[f.key] && localize(o.label, locale) === localize(p.label, locale),
        ),
    );
  const presets = all.filter((p, i) => {
    const keys = Object.keys(p.values);
    // When only a single option parameter remains, the button and the option below are redundant and thus hidden.
    const sameAsChoice =
      keys.length === 1 && action.fields.find((f) => f.key === keys[0])?.kind === 'choice';
    return (
      keys.length > 0 &&
      !sameAsChoice &&
      !choiceFor(p) &&
      all.findIndex((q) => JSON.stringify(q.values) === JSON.stringify(p.values)) === i
    );
  });
  const set = (key: string, value: unknown) => {
    const preset = all.find((p) => p.values[key] === value && choiceFor(p)?.key === key);
    onChange({ ...values, ...preset?.values, [key]: value });
  };
  return (
    <View style={styles.form}>
      {presets.length > 0 ? (
        <View style={styles.wrap}>
          {presets.map((p) => (
            <Pill
              key={p.id}
              palette={palette}
              testID={`${testPrefix}-preset-${p.id}`}
              label={localize(p.label, locale)}
              selected={Object.entries(p.values).every(([k, v]) => values[k] === v)}
              onPress={() => onChange({ ...values, ...p.values })}
            />
          ))}
        </View>
      ) : null}
      {shown.map((field) => (
        <View key={field.key} style={styles.field}>
          {hideLabels ? null : (
            <Text style={[palette.font('bodyBold', 14), { color: palette.text }]}>
              {localize(field.label, locale)}
            </Text>
          )}
          <FieldInput
            field={field}
            value={values[field.key]}
            onChange={(v) => set(field.key, v)}
            palette={palette}
            locale={locale}
            testID={`${testPrefix}-${field.key}`}
            collection={collection}
            tableId={field.collectionKey ? values[field.collectionKey] : undefined}
          />
          {field.kind === 'secret' && field.confirm ? (
            <>
              <Text style={[palette.font('bodyBold', 14), { color: palette.text }]}>
                {t(locale, 'askPasswordAgain')}
              </Text>
              <FieldInput
                field={field}
                value={values[againKey(field.key)]}
                onChange={(v) => set(againKey(field.key), v)}
                palette={palette}
                locale={locale}
                testID={`${testPrefix}-${field.key}-again`}
              />
            </>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function FieldInput({
  field,
  value,
  onChange,
  palette,
  locale,
  testID,
  collection,
  tableId,
}: {
  field: ParamField;
  value: unknown;
  onChange: (value: unknown) => void;
  palette: Palette;
  locale: Locale;
  testID: string;
  collection?: Collection | undefined;
  tableId?: unknown;
}) {
  const input = [
    styles.input,
    palette.font('body', 16),
    {
      color: palette.text,
      borderColor: palette.border,
      borderRadius: palette.controlRadius,
      backgroundColor: palette.surface,
    },
  ];
  switch (field.kind) {
    case 'choice':
      return (
        <View style={styles.wrap}>
          {field.options!.map((o) => (
            <Pill
              key={String(o.value)}
              palette={palette}
              testID={`${testID}-${String(o.value)}`}
              label={localize(o.label, locale)}
              selected={value === o.value}
              onPress={() => onChange(o.value)}
            />
          ))}
        </View>
      );
    case 'toggle':
      return (
        <Switch
          testID={testID}
          value={Boolean(value ?? field.defaultOn)}
          onValueChange={onChange}
          trackColor={{ true: palette.primary }}
        />
      );
    case 'number':
      return (
        <View style={styles.row}>
          <TextInput
            testID={testID}
            style={[input, styles.number]}
            keyboardType="decimal-pad"
            value={value === undefined || value === null ? '' : String(value)}
            onChangeText={(text) => {
              const n = Number(text.replace(',', '.'));
              onChange(text.trim() === '' || Number.isNaN(n) ? text : n);
            }}
          />
          {field.unit ? (
            <Text style={[palette.font('body', 15), { color: palette.muted }]}>
              {paramUnitLabel(field.unit, locale)}
            </Text>
          ) : null}
          {field.min !== undefined && field.max !== undefined ? (
            <Text style={[palette.font('body', 13), { color: palette.caption }]}>
              {field.zeroMeans
                ? `0 = ${localize(field.zeroMeans, locale)}`
                : `${field.min}–${field.max}`}
            </Text>
          ) : null}
        </View>
      );
    case 'collection':
      return (
        <CollectionInput value={value} onChange={onChange} palette={palette} testID={testID} />
      );
    case 'fields':
      return field.collectionKey ? (
        <BoundFieldSelection
          field={field}
          value={value}
          onChange={onChange}
          palette={palette}
          locale={locale}
          testID={testID}
          collection={collection}
          tableId={tableId}
        />
      ) : (
        <FieldSelection
          field={field}
          value={value}
          onChange={onChange}
          palette={palette}
          locale={locale}
          testID={testID}
          collection={collection}
        />
      );
    case 'secret':
      return (
        <TextInput
          testID={testID}
          style={input}
          value={typeof value === 'string' ? value : ''}
          onChangeText={onChange}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          textContentType="none"
        />
      );
    default:
      return (
        <TextInput
          testID={testID}
          multiline={field.multiline}
          style={[input, field.multiline ? styles.multiline : null]}
          value={value === undefined || value === null ? '' : String(value)}
          onChangeText={onChange}
          autoCapitalize="none"
          autoCorrect={false}
        />
      );
  }
}

type FieldSelectionProps = {
  field: ParamField;
  value: unknown;
  onChange: (value: unknown) => void;
  palette: Palette;
  locale: Locale;
  testID: string;
  collection?: Collection | undefined;
};
function BoundFieldSelection(props: FieldSelectionProps & { tableId?: unknown }) {
  const collection = useWorkspace((s) => s.config?.data.tables.find((c) => c.id === props.tableId));
  return (
    <FieldSelection
      {...props}
      collection={props.tableId === undefined ? props.collection : collection}
    />
  );
}
function FieldSelection({
  field,
  value,
  onChange,
  palette,
  locale,
  testID,
  collection,
}: FieldSelectionProps) {
  const chosen = Array.isArray(value) ? (value as string[]) : [];
  if (!collection) {
    return (
      <Text style={[palette.font('body', 14), { color: palette.muted }]}>
        {t(locale, 'ParamForm_Choose_a_data_table_first_b5c9a')}
      </Text>
    );
  }
  return (
    <View style={styles.wrap}>
      {[
        ...collection.fields.filter(
          (f) =>
            (!field.fieldTypes || field.fieldTypes.includes(f.type)) &&
            (!field.textFormat || (f.type === 'text' && f.format === field.textFormat)),
        ),
        ...(field.builtInCreated
          ? [{ id: 'createdAt', name: t(locale, 'data_Created_1626a') }]
          : []),
      ].map((f) => (
        <Pill
          key={f.id}
          palette={palette}
          testID={`${testID}-${f.id}`}
          label={
            chosen.includes(f.id) && !field.single
              ? `${chosen.indexOf(f.id) + 1}. ${f.name}`
              : f.name
          }
          selected={chosen.includes(f.id)}
          onPress={() =>
            onChange(
              chosen.includes(f.id)
                ? chosen.filter((x) => x !== f.id)
                : field.single
                  ? [f.id]
                  : [...chosen, f.id],
            )
          }
        />
      ))}
    </View>
  );
}

/** Select a data table (options come from current config). */
function CollectionInput({
  value,
  onChange,
  palette,
  testID,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  palette: Palette;
  testID: string;
}) {
  const collections = useWorkspace((s) => s.config?.data.tables ?? []);
  return (
    <View style={styles.wrap}>
      {collections.map((c) => (
        <Pill
          key={c.id}
          palette={palette}
          testID={`${testID}-${c.id}`}
          label={c.name}
          selected={value === c.id}
          onPress={() => onChange(c.id)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 16 },
  field: { gap: 8 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: { borderWidth: 1.5, paddingHorizontal: 14, paddingVertical: 12 },
  number: { minWidth: 110 },
  multiline: { minHeight: 120, textAlignVertical: 'top' },
});
