import { linkTarget, type FieldLink, type Locale } from '@morph/core';
import { Alert, Linking } from 'react-native';

import { t } from '../i18n';

/** Ask before opening URLs outside the app, specifying the target address (D-044). open is called only after the user taps "Open". */
export function confirmOpenLink(locale: Locale, url: string, open: () => void): void {
  Alert.alert(
    t(locale, 'openLinkTitle'),
    t(locale, 'openLinkMessage', { target: linkTarget(url) }),
    [
      { text: t(locale, 'cancel'), style: 'cancel' },
      { text: t(locale, 'openLink'), onPress: open },
    ],
  );
}

/**
 * Steps for phone calls, SMS, emails, and website links (D-428, formerly hardcoded buttons on the
 * record page, D-422). Phone and email are handed over to the system's dialer and mail composer
 * pages without sending anything out; URLs are asked first. No data is written. Do not use
 * canOpenURL (which requires declaring a whitelist): show a message if it fails (on devices
 * without a phone or email app).
 */
export function openFieldLink(link: FieldLink, locale: Locale): void {
  const open = () =>
    void Linking.openURL(link.url).catch(() => Alert.alert(t(locale, 'openLinkFailed')));
  if (link.kind === 'url') confirmOpenLink(locale, link.url, open);
  else open();
}
