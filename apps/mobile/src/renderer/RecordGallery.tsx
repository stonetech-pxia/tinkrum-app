import type { Collection, DataRecord } from '@morph/core';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AssetRecord } from '../storage/types';
import { AttachmentThumb, firstImage } from './Attachments';
import type { RenderEnv } from './components';

// 图片墙（D-540）：每条记录附件里的第一张图片（和列表的缩略图同一个规则），标题在下面；
// 没有图片的画一块占位，写着标题。点一张打开这一条。看什么都不写（底线 15）。

const COLUMNS = 2;

export function RecordGallery({
  blockId,
  collection,
  records,
  env,
  assets,
  titleOf,
  open,
}: {
  blockId: string;
  collection: Collection;
  records: readonly DataRecord[];
  env: RenderEnv;
  assets: ReadonlyMap<string, AssetRecord> | null;
  titleOf: (r: DataRecord) => string;
  open: ((r: DataRecord) => void) | undefined;
}) {
  const { palette } = env;
  const [width, setWidth] = useState(0);
  const gap = palette.gap - 4;
  const size = width > 0 ? Math.floor((width - gap * (COLUMNS - 1)) / COLUMNS) : 0;
  const radius = Math.min(palette.controlRadius, 12);
  return (
    <View
      testID={`gallery-${blockId}`}
      style={[styles.grid, { gap }]}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {size === 0
        ? null
        : records.map((r) => {
            const image = assets ? firstImage(r, collection, assets) : null;
            const title = titleOf(r);
            return (
              <Pressable
                key={r.id}
                testID={`record-${r.id}`}
                accessibilityRole="button"
                accessibilityLabel={title}
                onPress={open ? () => open(r) : undefined}
                onLongPress={env.onLongPress}
                disabled={!open}
                style={{ width: size, gap: 4 }}>
                {image ? (
                  <AttachmentThumb
                    asset={image}
                    size={size}
                    radius={radius}
                    testID={`gallery-image-${r.id}`}
                  />
                ) : (
                  <View
                    testID={`gallery-placeholder-${r.id}`}
                    style={[
                      styles.placeholder,
                      {
                        width: size,
                        height: size,
                        borderRadius: radius,
                        backgroundColor: palette.surface,
                        borderColor: palette.border,
                      },
                    ]}>
                    <Text
                      numberOfLines={3}
                      style={[palette.font('body', 13), styles.center, { color: palette.muted }]}>
                      {title}
                    </Text>
                  </View>
                )}
                <Text
                  numberOfLines={1}
                  style={[palette.font('title', 14), { color: palette.text }]}>
                  {title}
                </Text>
              </Pressable>
            );
          })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  center: { textAlign: 'center' },
});
