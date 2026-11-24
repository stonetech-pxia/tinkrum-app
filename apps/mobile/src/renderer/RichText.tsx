import { parseRichText, type Span } from '@morph/core';
import { Linking, StyleSheet, Text, View, type TextStyle } from 'react-native';

import type { RenderEnv } from './components';
import { confirmOpenLink } from './open-link';

// Rich text rendering (D-044): bold, italic, links, lists. Data only, no executable content. Links
// can only be https or mailto (validated by schema), and require user confirmation of the target
// address before opening.

export function RichText({
  source,
  env,
  color,
  size,
  align,
}: {
  source: string;
  env: RenderEnv;
  color: string;
  size: number;
  align?: TextStyle;
}) {
  const { palette, locale } = env;
  const lineHeight = Math.round(size * 1.5 * palette.theme.fontScale);
  const base = [palette.font('body', size), { color, lineHeight }, align];

  function open(url: string) {
    if (!env.interactive) return;
    if (env.locked) return env.locked();
    confirmOpenLink(locale, url, () => void Linking.openURL(url));
  }

  const span = (s: Span, i: number) => {
    const style: TextStyle[] = [];
    if (s.bold) style.push(palette.font('bodyBold', size));
    if (s.italic) {
      style.push(
        palette.theme.font === 'clay'
          ? { fontFamily: s.bold ? 'Karla_700Bold' : 'Karla_400Regular_Italic' }
          : { fontStyle: 'italic' },
      );
    }
    if (s.url) style.push({ color: palette.primaryText, textDecorationLine: 'underline' });
    return (
      <Text
        key={i}
        style={style}
        onPress={s.url ? () => open(s.url!) : undefined}
        accessibilityRole={s.url ? 'link' : undefined}>
        {s.text}
      </Text>
    );
  };

  return (
    <View style={styles.blocks}>
      {parseRichText(source).map((block, b) =>
        block.type === 'paragraph' ? (
          <Text key={b} style={base}>
            {block.spans.map(span)}
          </Text>
        ) : (
          <View key={b} style={styles.list}>
            {block.items.map((item, i) => (
              <View key={i} style={styles.item}>
                <Text style={[base, block.ordered ? styles.number : styles.bullet]}>
                  {block.ordered ? `${i + 1}.` : '•'}
                </Text>
                <Text style={[base, styles.flex]}>{item.map(span)}</Text>
              </View>
            ))}
          </View>
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  blocks: { gap: 8 },
  list: { gap: 4 },
  item: { flexDirection: 'row', gap: 6 },
  bullet: { minWidth: 10 },
  number: { minWidth: 18 },
  flex: { flex: 1 },
});
