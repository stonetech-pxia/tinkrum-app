import {
  FILE_LIMITS,
  dataRows,
  dateOrderOf,
  fieldDefinition,
  formatValue,
  importLimitProblem,
  importTargets,
  planImport,
  proposeMapping,
  readCellFor,
  sheetColumns,
  type Collection,
  type DateOrder,
  type ImportPlan,
  type SheetCell,
  type SheetRows,
  type SkippedGroup,
  type SpreadsheetError,
} from '@morph/core';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { readSpreadsheet, spreadsheetKind } from '@/data/import-file';
import { t } from '@/i18n';
import { Button, Card } from '@/renderer/ui';
import { usePalette, type Palette } from '@/renderer/theme';
import { newAssetId } from '@/runtime/ids';
import { Toast } from '@/shell/Toast';
import { useCalendar, useWorkspace, useWorkspaceContext } from '@/workspace/context';

/**
 * 「设置 → 数据 → 从文件导入记录」（D-574，创始人 2026-11-16 决定 ⑦）：系统层的页面，不在配置里，Tink 改不了。
 * 选一个 .xlsx / .csv → 列对到字段（本机按名字提议，用户看着样例改）→ 汇总（几条进哪张表、哪些行为什么不导）→
 * 用户点「导入」才写，一个事务；之后提示条能撤销（底线 11），「设置 → 数据」里能整批删。
 * 文件只在本机读，选择器的副本读完就删，原件不动（底线 1、2、4、14）。看、换对应都不写（底线 15）。
 */

const ERROR_KEYS = {
  unsupported: 'importErrorUnsupported',
  notSpreadsheet: 'importErrorNotSpreadsheet',
  encoding: 'importErrorEncoding',
  tooLarge: 'importErrorTooLarge',
  empty: 'importErrorEmpty',
} as const satisfies Record<SpreadsheetError, string>;

const REASON_KEYS = {
  invalid: 'importReason_invalid',
  required: 'importReason_required',
  tooLong: 'importReason_tooLong',
  tooSmall: 'importReason_tooSmall',
  tooLarge: 'importReason_tooLarge',
} as const satisfies Record<SkippedGroup['code'], string>;

/** 每列给看的样例：前三个有内容的格子。 */
const SAMPLES = 3;

interface Loaded {
  fileName: string;
  sheets: SheetRows[];
}

interface Settings {
  sheet: number;
  header: boolean;
  mapping: (string | null)[];
  orders: DateOrder[];
  /** 这一列的日期两种读法都说得通（让用户选日在前还是月在前）。 */
  ambiguous: boolean[];
}

function settingsFor(collection: Collection, rows: SheetCell[][], sheet: number, header: boolean) {
  const columns = sheetColumns(rows, header);
  const data = dataRows(rows, header);
  const dates = columns.map((_, i) => dateOrderOf(data.map((r) => r.cells[i])));
  return {
    sheet,
    header,
    mapping: header ? proposeMapping(columns, collection) : columns.map(() => null),
    orders: dates.map((d) => d.order),
    ambiguous: dates.map((d) => d.ambiguous),
  };
}

export default function ImportRecordsRoute() {
  const { table } = useLocalSearchParams<{ table: string }>();
  const { repo, files, locale } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config)!;
  const bump = useWorkspace((s) => s.bumpRecords);
  const showToast = useWorkspace((s) => s.showToast);
  const palette = usePalette(config.theme);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const cal = useCalendar();
  const collection = config.data.tables.find((c) => c.id === table);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const targets = useMemo(() => (collection ? importTargets(collection) : []), [collection]);
  if (!collection) return null;
  const name = collection.name;
  const rows = loaded && settings ? loaded.sheets[settings.sheet]!.rows : [];

  async function choose() {
    setError(null);
    const picked = (await files.pickDocuments(['*/*'], false))?.[0];
    if (!picked) return;
    setBusy(true);
    try {
      const kind = spreadsheetKind(picked.name, picked.mimeType);
      if (!kind) return setError(t(locale, ERROR_KEYS.unsupported));
      if ((picked.size ?? 0) > FILE_LIMITS.maxFileBytes)
        return setError(t(locale, ERROR_KEYS.tooLarge));
      let bytes: Uint8Array;
      try {
        bytes = await files.readUri(picked.uri);
      } catch {
        return setError(t(locale, ERROR_KEYS.notSpreadsheet));
      }
      const read = readSpreadsheet(kind, bytes);
      if (!read.ok) return setError(t(locale, ERROR_KEYS[read.error]));
      setLoaded({ fileName: picked.name, sheets: read.sheets });
      setSettings(settingsFor(collection!, read.sheets[0]!.rows, 0, true));
    } finally {
      // 选择器放在 App 缓存里的副本：读完就删（成功、读不了都删）；原件和 content:// 不动（底线 4）。
      await files.removePickedCopies([picked.uri]).catch(() => undefined);
      setBusy(false);
    }
  }

  const change = (next: Partial<Settings>) => setSettings((s) => (s ? { ...s, ...next } : s));
  const reset = (sheet: number, header: boolean) =>
    setSettings(settingsFor(collection, loaded!.sheets[sheet]!.rows, sheet, header));

  function setField(col: number, fieldId: string | null) {
    // 一个字段只放一列：选了别的列已经用的字段，那一列改成跳过。
    const mapping = settings!.mapping.map((f, i) =>
      i === col ? fieldId : f === fieldId && fieldId !== null ? null : f,
    );
    change({ mapping });
  }

  async function review() {
    const next = planImport(collection!, rows, settings!, new Date(), cal);
    const existing =
      (await repo.countRecords()).find((c) => c.collectionId === collection!.id)?.count ?? 0;
    const problem = importLimitProblem(next.rows, next.entries.length, existing);
    setRefusal(
      problem === null
        ? null
        : problem.code === 'tooManyRows'
          ? t(locale, 'importErrorTooManyRows', { n: next.rows, max: problem.max })
          : t(locale, 'importErrorTableFull', {
              n: next.entries.length,
              table: name,
              room: problem.room,
            }),
    );
    setPlan(next);
  }

  async function confirm() {
    if (!plan || !loaded) return;
    setBusy(true);
    try {
      // 刚才看汇总到现在，别处可能又加了记录：再查一次上限。
      const existing =
        (await repo.countRecords()).find((c) => c.collectionId === collection!.id)?.count ?? 0;
      if (importLimitProblem(plan.rows, plan.entries.length, existing)) return void review();
      const now = Date.now();
      const id = newAssetId();
      // 按文件里的顺序：每条晚一毫秒，按新建时间排时和文件一样。
      await repo.importRecords(
        { id, collectionId: collection!.id, fileName: loaded.fileName, createdAt: now },
        plan.entries.map((e, i) => ({
          id: newAssetId(),
          collectionId: collection!.id,
          values: e.values,
          createdAt: now + i,
          updatedAt: now + i,
        })),
      );
      bump([collection!.id]);
      const message = t(locale, 'importDone', { n: plan.entries.length, table: name });
      showToast({ message, undoImport: { id, table: collection!.id } });
      setDone(message);
    } finally {
      setBusy(false);
    }
  }

  const caption = [palette.font('body', 13), { color: palette.caption }];
  const body = [palette.font('body', 15), { color: palette.text }];
  const fieldName = (id: string) => collection.fields.find((f) => f.id === id)?.name ?? id;
  const rowList = (g: SkippedGroup) => `${g.rows.join(', ')}${g.count > g.rows.length ? '…' : ''}`;

  let content;
  if (done) {
    content = (
      <Card palette={palette} testID="import-done">
        <Text style={body}>{done}</Text>
        <Button palette={palette} label={t(locale, 'done')} onPress={() => router.back()} />
      </Card>
    );
  } else if (plan && settings) {
    content = (
      <Card palette={palette} testID="import-summary">
        {refusal ? (
          <Text testID="import-refused" style={[body, { color: palette.danger }]}>
            {refusal}
          </Text>
        ) : (
          <Text style={[palette.font('title', 16), { color: palette.text }]}>
            {plan.entries.length > 0
              ? t(locale, 'importSummary', { n: plan.entries.length, table: name })
              : t(locale, 'importSummaryNone')}
          </Text>
        )}
        {!refusal && plan.skipped.length > 0 ? (
          <View style={{ gap: 4 }}>
            <Text style={body}>
              {t(locale, 'importLeftOut', { n: plan.rows - plan.entries.length })}
            </Text>
            {plan.skipped.map((g) => (
              <Text key={`${g.code}-${g.fieldId}`} style={caption} testID="import-reason">
                {t(locale, REASON_KEYS[g.code], {
                  n: g.count,
                  field: fieldName(g.fieldId),
                  rows: rowList(g),
                  limit: g.limit ?? '',
                })}
              </Text>
            ))}
          </View>
        ) : null}
        <View style={styles.buttons}>
          <Button
            palette={palette}
            variant="outline"
            testID="import-back"
            label={t(locale, 'importChangeColumns')}
            onPress={() => setPlan(null)}
          />
          {!refusal && plan.entries.length > 0 ? (
            <Button
              palette={palette}
              testID="import-confirm"
              loading={busy}
              label={t(locale, 'importConfirm', { n: plan.entries.length })}
              onPress={() => void confirm()}
            />
          ) : null}
        </View>
      </Card>
    );
  } else if (loaded && settings) {
    const columns = sheetColumns(rows, settings.header);
    const data = dataRows(rows, settings.header);
    content = (
      <>
        {loaded.sheets.length > 1 ? (
          <View style={styles.chips}>
            <Text style={caption}>{t(locale, 'importSheet')}</Text>
            {loaded.sheets.map((s, i) => (
              <Chip
                key={i}
                palette={palette}
                testID={`import-sheet-${i}`}
                label={s.name}
                selected={settings.sheet === i}
                onPress={() => reset(i, settings.header)}
              />
            ))}
          </View>
        ) : null}
        <View style={styles.switchRow}>
          <Text style={[body, styles.flex]}>{t(locale, 'importHeaderRow')}</Text>
          <Switch
            testID="import-header"
            value={settings.header}
            onValueChange={(on) => reset(settings.sheet, on)}
            trackColor={{ true: palette.primary }}
          />
        </View>
        <Text style={caption}>{t(locale, 'importColumnsHint')}</Text>
        {columns.map((title, col) => {
          const fieldId = settings.mapping[col] ?? null;
          const field = fieldId ? collection.fields.find((f) => f.id === fieldId) : undefined;
          const samples = data
            .map((r) => r.cells[col])
            .filter((c): c is SheetCell => !!c && (c.text.trim() !== '' || c.number !== undefined))
            .slice(0, SAMPLES);
          const isDate = field?.type === 'date' || field?.type === 'datetime';
          return (
            <Card key={col} palette={palette} testID={`import-column-${col}`}>
              <Text style={[palette.font('title', 15), { color: palette.text }]}>
                {title || t(locale, 'importColumn', { col: col + 1 })}
              </Text>
              {samples.map((cell, i) => (
                <Text key={i} style={caption} numberOfLines={1} testID={`import-sample-${col}`}>
                  {sample(cell, field, settings.orders[col] ?? 'dmy', locale)}
                </Text>
              ))}
              <View style={styles.chips}>
                <Chip
                  palette={palette}
                  testID={`import-map-${col}-skip`}
                  label={t(locale, 'importSkip')}
                  selected={fieldId === null}
                  onPress={() => setField(col, null)}
                />
                {targets.map((f) => (
                  <Chip
                    key={f.id}
                    palette={palette}
                    testID={`import-map-${col}-${f.id}`}
                    label={f.name}
                    selected={fieldId === f.id}
                    onPress={() => setField(col, f.id)}
                  />
                ))}
              </View>
              {isDate && settings.ambiguous[col] ? (
                <View style={styles.chips}>
                  {(['dmy', 'mdy'] as const).map((order) => (
                    <Chip
                      key={order}
                      palette={palette}
                      testID={`import-order-${col}-${order}`}
                      label={t(locale, order === 'dmy' ? 'importDayFirst' : 'importMonthFirst')}
                      selected={settings.orders[col] === order}
                      onPress={() =>
                        change({ orders: settings.orders.map((o, i) => (i === col ? order : o)) })
                      }
                    />
                  ))}
                </View>
              ) : null}
            </Card>
          );
        })}
        <Button
          palette={palette}
          testID="import-continue"
          label={t(locale, 'importContinue')}
          disabled={!settings.mapping.some((f) => f !== null)}
          onPress={() => void review()}
        />
      </>
    );
  } else {
    content = (
      <Card palette={palette}>
        <Text style={body}>
          {targets.length > 0
            ? t(locale, 'importIntro', { table: name })
            : t(locale, 'importErrorNoFields', { table: name })}
        </Text>
        {error ? (
          <Text testID="import-error" style={[body, { color: palette.danger }]}>
            {error}
          </Text>
        ) : null}
        {targets.length > 0 ? (
          <Button
            palette={palette}
            testID="import-choose"
            loading={busy}
            label={busy ? t(locale, 'importReading') : t(locale, 'importChooseFile')}
            onPress={() => void choose()}
          />
        ) : null}
      </Card>
    );
  }

  return (
    <View testID="import-records" style={[styles.flex, { backgroundColor: palette.background }]}>
      <ScrollView
        contentContainerStyle={{ padding: palette.pad, gap: palette.gap - 4, paddingBottom: 120 }}>
        {content}
      </ScrollView>
      <Toast palette={palette} bottom={insets.bottom + 16} />
    </View>
  );
}

/** 一个样例格子：对到字段时显示读成的值（日期按这一列的顺序），读不出来时直说；没对上时显示原样。 */
function sample(
  cell: SheetCell,
  field: Collection['fields'][number] | undefined,
  order: DateOrder,
  locale: Parameters<typeof t>[0],
): string {
  if (!field) return cell.text;
  const read = readCellFor(field, cell, order);
  const written =
    read && !('invalid' in read) ? fieldDefinition(field.type).write?.(field, read.value) : null;
  if (!written || 'issue' in written)
    return read === undefined ? '' : t(locale, 'importSampleUnreadable', { value: cell.text });
  return `${cell.text} → ${formatValue(field, written.value, locale)}`;
}

function Chip({
  palette,
  label,
  selected,
  onPress,
  testID,
}: {
  palette: Palette;
  label: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, { borderColor: selected ? palette.primary : palette.border }]}>
      <Text
        style={[
          palette.font('bodyMedium', 14),
          { color: selected ? palette.primary : palette.text },
        ]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, borderWidth: 1 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  buttons: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
});
