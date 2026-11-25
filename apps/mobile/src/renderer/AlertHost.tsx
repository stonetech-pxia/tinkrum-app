import type { Locale } from '@morph/core';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  type AlertButton,
  type AlertOptions,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { t } from '../i18n';
import { Dialog } from './Overlays';
import type { Palette } from './theme';
import { Button } from './ui';

interface Entry {
  id: number;
  title: string;
  message?: string;
  buttons: AlertButton[];
  options?: AlertOptions;
}

/**
 * On Android the system alert (`Alert.alert`) is drawn as the app's own `Dialog`: the Material
 * dialog ignores the theme. Call sites keep writing `Alert.alert(...)` with the same arguments and
 * callbacks; while a host is mounted it draws them, without one (rescue page, tests) the system
 * alert stays. One is shown at a time, the rest queue.
 * Not on iOS: an RN `Modal` cannot present over an already open `Modal` there (a bottom sheet or a
 * modal route; "Attempt to present … which is already presenting", seen in the simulator: the alert
 * never appeared), while the system alert can, and its look is the system's anyway.
 */
export function AlertHost({ palette, locale }: { palette: Palette; locale: Locale }) {
  const [queue, setQueue] = useState<Entry[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const system = Alert.alert;
    Alert.alert = (title, message, buttons, options) => {
      const entry: Entry = {
        id: nextId.current++,
        title: title ?? '',
        ...(message ? { message } : {}),
        buttons: buttons?.length ? buttons : [{ text: t(locale, 'ok') }],
        ...(options ? { options } : {}),
      };
      setQueue((q) => [...q, entry]);
    };
    return () => {
      Alert.alert = system;
    };
  }, [locale]);

  const entry = queue[0];
  if (!entry) return null;
  // Dequeue first, then call back: an alert raised by the callback queues behind and shows next.
  const dismiss = () => setQueue((q) => q.slice(1));
  const cancelable = entry.options?.cancelable === true;
  return (
    <Dialog
      key={entry.id}
      palette={palette}
      locale={locale}
      testID="alert-dialog"
      {...(cancelable
        ? {
            onClose: () => {
              dismiss();
              entry.options?.onDismiss?.();
            },
          }
        : {})}
      style={styles.dialog}>
      <Text accessibilityRole="header" style={[palette.font('title', 20), { color: palette.text }]}>
        {entry.title}
      </Text>
      {entry.message ? (
        <View style={styles.lines}>
          {entry.message.split('\n').map((line, i) => (
            <Text
              key={i}
              style={[palette.font('body', 15), { color: palette.text, lineHeight: 21 }]}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}
      <View style={styles.buttons}>
        {entry.buttons.map((b, i) => (
          <Button
            key={i}
            palette={palette}
            variant="text"
            label={b.text ?? ''}
            danger={b.style === 'destructive'}
            testID={`alert-button-${i}`}
            style={b.style === 'cancel' ? { opacity: 0.8 } : undefined}
            onPress={() => {
              dismiss();
              b.onPress?.();
            }}
          />
        ))}
      </View>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  dialog: { gap: 12 },
  lines: { gap: 6 },
  buttons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    columnGap: 16,
    marginTop: 4,
  },
});
