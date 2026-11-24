import type { Collection, DataRecord } from '@morph/core';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AssetRecord } from '../storage/types';
import { AttachmentThumb, firstImage } from './Attachments';
import type { RenderEnv } from './components';
import { ColorDot, type RecordMarks } from './record-marks';

// Image wall (D-540): the first image in each entry's attachments (following the same rule as list
// thumbnails), with the title below; displays a placeholder block with the title if there are no
// images. Tapping an image opens that entry. Displays nothing when viewing (invariant 15).

const COLUMNS = 2;

export function RecordGallery({
  blockId,
  collection,
  records,
  env,
  assets,
  titleOf,
  marks,
  open,
}: {
  blockId: string;
  collection: Collection;
  records: readonly DataRecord[];
  env: RenderEnv;
  assets: ReadonlyMap<string, AssetRecord> | null;
  titleOf: (r: DataRecord) => string;
  marks: RecordMarks;
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
                <View style={styles.titleRow}>
                  <ColorDot color={marks.colorOf(r)} recordId={r.id} />
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.flex,
                      palette.font('title', 14),
                      { color: marks.warns(r) ? palette.danger : palette.text },
                    ]}>
                    {title}
                  </Text>
                </View>
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
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  flex: { flex: 1 },
});
