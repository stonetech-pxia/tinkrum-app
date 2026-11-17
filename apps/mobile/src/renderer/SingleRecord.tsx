import {
  attachmentIds,
  attachmentIdsOfRecords,
  calendarOf,
  findWorkflowTarget,
  formatRef,
  handedFilesFor,
  handedInput,
  isToolRefUse,
  quickActionsOf,
  recordsValue,
  recordToVCard,
  type BlockOf,
  type AttachmentInfo,
  type ComponentStyle,
} from '@morph/core';
import { encodePng, qrMatrix, qrToRgba } from '@morph/tool-qr';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { useComputedRecords, useLinkResolver } from '../data/records';
import { t } from '../i18n';
import { useHandedRun } from '../run/useHandedRun';
import { useWorkspaceContext } from '../workspace/context';
import { AttachmentThumb, useAssets } from './Attachments';
import type { RenderEnv } from './components';
import { useCollection } from './data';
import { openEditor } from './open-row';
import { cardColors } from './theme';
import { Button, Card } from './ui';

// 一张表的一条记录（最早加的那条，D-424）：几个字段、「编辑」，可以加这条记录的 vCard 二维码。
// source.record（D-558）：给一条记录用的页面上是打开的那一条（画的时候 "$record" 已换成它的 ID）。
// 附件字段里的图片画成图（D-558），别的文件照旧是一行字。
// 二维码画的时候现算，不存（底线 14）；看的时候什么都不写（底线 15）。

/** 手机屏幕上还扫得出来的最大边长（模块数）：再大就太密了，只写一句说明。 */
const MAX_QR_MODULES = 105;
const QR_SIDE = 240;
/** 附件里的图片画多大（正方形，按显示的大小解码）。 */
const PICTURE_SIDE = 132;

function qrImage(text: string): string | null {
  try {
    const matrix = qrMatrix(text, { ecc: 'L' });
    if (matrix.size > MAX_QR_MODULES) return null;
    const scale = Math.ceil((QR_SIDE * 3) / (matrix.size + 8));
    const bytes = encodePng(qrToRgba(matrix, { scale }));
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x1000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x1000));
    return `data:image/png;base64,${btoa(binary)}`;
  } catch {
    // 内容超过二维码的容量。
    return null;
  }
}

export function SingleRecord({
  block,
  env,
  tone,
}: {
  block: BlockOf<'single'>;
  env: RenderEnv;
  tone?: ComponentStyle['tone'];
}) {
  const { palette, locale } = env;
  const router = useRouter();
  const collection = useCollection(env, block.source.table);
  const cal = calendarOf(env.config);
  const { view, records } = useComputedRecords(env.config.data.tables, collection, cal);
  const links = useLinkResolver(view);
  const record =
    records &&
    (block.source.record !== undefined
      ? records.find((r) => r.id === block.source.record)
      : [...records].sort((a, b) => a.createdAt - b.createdAt)[0]);
  const vcard =
    block.show.qr && collection && record ? recordToVCard(collection.fields, record.values) : null;
  const qr = useMemo(() => (vcard ? qrImage(vcard) : null), [vcard]);
  // 块上的工具（D-428）：点了才把这一条交给它。
  const { run, elements } = useHandedRun(palette);
  const use = block.tools?.[0];
  const tool =
    use && isToolRefUse(use)
      ? findWorkflowTarget(quickActionsOf(env.config), use.tool, locale)
      : undefined;
  // 第一步收文件的快捷操作（D-442）：交这一条记录第一个附件字段里它收的那些文件，读到了才有按钮。
  const { registry } = useWorkspaceContext();
  const takesFiles = tool !== undefined && handedInput(tool.steps, registry) === 'files';
  const fileIds =
    takesFiles && collection && record ? attachmentIdsOfRecords(collection, [record]) : [];
  // 显示的附件字段里的文件：读到是图片的画成图。
  const shownFiles = (collection && record ? block.show.fields : []).flatMap((id) =>
    collection?.fields.some((f) => f.id === id && f.type === 'file')
      ? attachmentIds(record!.values[id]).map((file) => ({ field: id, file }))
      : [],
  );
  const loaded = useAssets([...fileIds, ...shownFiles.map((x) => x.file)]);
  if (!collection || !view || records === null) return null;
  const infos = new Map<string, AttachmentInfo>(
    [...loaded].flatMap(([id, asset]) =>
      asset ? [[id, { id, name: asset.name, mimeType: asset.mimeType, size: asset.size }]] : [],
    ),
  );
  const files =
    takesFiles && record
      ? handedFilesFor(registry.actions.get(tool.steps[0]!.action)!, collection, [record], infos)
      : null;
  const background = cardColors(palette, tone).background;
  if (!record)
    return (
      <Card palette={palette} background={background}>
        <Text style={[palette.font('body', 14), { color: palette.caption }]}>
          {t(locale, 'noRecords')}
        </Text>
      </Card>
    );
  const now = new Date();
  const pictures = (id: string) =>
    shownFiles.flatMap((x) => {
      const asset = x.field === id ? loaded.get(x.file) : undefined;
      return asset?.mimeType.startsWith('image/') ? [asset] : [];
    });
  const rows = block.show.fields.flatMap((id) => {
    const images = pictures(id);
    const text = images.length > 0 ? '' : formatRef(record, view, id, locale, links, now, cal);
    const name = view.fields.find((f) => f.id === id)?.name ?? id;
    return text || images.length > 0 ? [{ id, text, images, name }] : [];
  });
  return (
    <Card palette={palette} background={background} testID={`single-${record.id}`}>
      <View style={{ gap: 12 }}>
        {qr ? (
          <Image
            testID="single-qr"
            accessibilityRole="image"
            source={{ uri: qr }}
            resizeMode="contain"
            style={styles.qr}
          />
        ) : vcard ? (
          <Text
            testID="single-qr-note"
            style={[palette.font('body', 13), { color: palette.muted }]}>
            {t(locale, 'singleTooMuch')}
          </Text>
        ) : null}
        {rows.map((row, i) => (
          <View key={row.id} style={styles.field}>
            {i > 0 ? (
              <Text style={[palette.font('body', 12), { color: palette.caption }]}>{row.name}</Text>
            ) : null}
            {row.images.length > 0 ? (
              <View style={styles.pictures}>
                {row.images.map((asset) => (
                  <AttachmentThumb
                    key={asset.id}
                    asset={asset}
                    size={PICTURE_SIDE}
                    radius={10}
                    testID={`single-image-${asset.id}`}
                  />
                ))}
              </View>
            ) : (
              <Text
                style={[
                  i === 0 ? palette.font('title', 20) : palette.font('body', 15),
                  { color: palette.text },
                ]}>
                {row.text}
              </Text>
            )}
          </View>
        ))}
        <Button
          palette={palette}
          testID="single-edit"
          variant="outline"
          label={t(locale, 'editRecord')}
          onPress={
            env.interactive
              ? (env.locked ?? (() => openEditor(router, collection.id, record.id)))
              : undefined
          }
          onLongPress={env.onLongPress}
        />
        {tool && (!takesFiles || files) ? (
          <Button
            palette={palette}
            testID={`single-tool-${tool.id}`}
            variant="outline"
            label={tool.name}
            {...(tool.icon ? { icon: tool.icon } : {})}
            onPress={
              env.interactive
                ? (env.locked ??
                  (() => void run(tool, files ?? recordsValue(collection, [record]))))
                : undefined
            }
            onLongPress={env.onLongPress}
          />
        ) : null}
        {elements}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  qr: { width: QR_SIDE, height: QR_SIDE, alignSelf: 'center' },
  field: { gap: 2 },
  pictures: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
