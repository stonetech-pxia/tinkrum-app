import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { t } from '../i18n';
import type { Palette } from '../renderer/theme';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';

/** Duration after which the "Applied" banner automatically disappears (D-106); still undoable afterwards in "Settings -> Change History". */
export const APPLIED_BANNER_MS = 6000;

/**
 * Version banner: applied / reverted, with "Undo". Shown on both shell and standalone pages.
 * "Applied" automatically disappears after a few seconds to avoid being mistaken for undoing
 * other operations; warnings such as reverts and conflicts require manual user dismissal. Floats
 * over content (absolute positioning) without taking up layout space: page does not shift when
 * appearing and disappearing, preventing misclicks from content jumping. Placed at the top of its
 * container; uses BannerAnchor when there are other elements above the container.
 */
export function Banner({ palette }: { palette: Palette }) {
  const { locale } = useWorkspaceContext();
  const banner = useWorkspace((s) => s.banner);
  const undo = useWorkspace((s) => s.undo);
  const dismiss = useWorkspace((s) => s.dismissBanner);
  const hold = useWorkspace((s) => s.holdBanner);
  useEffect(() => {
    if (banner?.kind !== 'applied' || banner.held) return;
    const timer = setTimeout(dismiss, APPLIED_BANNER_MS);
    return () => clearTimeout(timer);
  }, [banner, dismiss]);
  if (!banner) return null;
  const warn = banner.kind !== 'applied';
  const color = palette.onAccent(warn ? palette.danger : palette.primary);
  return (
    <View
      testID="banner"
      style={[
        styles.floating,
        { left: palette.pad, right: palette.pad, paddingLeft: palette.inset },
        {
          backgroundColor: warn ? palette.danger : palette.primary,
          borderRadius: palette.controlRadius,
        },
      ]}>
      <Text
        numberOfLines={3}
        style={[styles.bannerText, palette.font('bodyMedium', 14), { color }]}>
        {banner.message}
      </Text>
      {banner.undoTo !== undefined ? (
        <Pressable
          testID="banner-undo"
          accessibilityRole="button"
          style={styles.action}
          onPressIn={() => hold(true)}
          onPressOut={() => hold(false)}
          onPress={undo}>
          <Text style={[palette.font('bodyBold', 14), { color }]}>{t(locale, 'undo')}</Text>
        </Pressable>
      ) : null}
      <Pressable
        style={styles.action}
        accessibilityRole="button"
        onPress={dismiss}
        accessibilityLabel={t(locale, 'close')}>
        <Text style={[palette.font('bodyBold', 14), { color }]}>✕</Text>
      </Pressable>
    </View>
  );
}

/** Draft notice (D-190): steps removed when re-applying, or a step that could no longer be displayed has been discarded. */
export function DraftNotice({ palette }: { palette: Palette }) {
  const { locale } = useWorkspaceContext();
  const notice = useWorkspace((s) => s.draftNotice);
  const dismiss = useWorkspace((s) => s.dismissDraftNotice);
  if (!notice) return null;
  return (
    <View
      testID="draft-notice"
      style={[
        styles.banner,
        { marginHorizontal: palette.pad, paddingHorizontal: palette.inset },
        { backgroundColor: palette.danger, borderRadius: palette.controlRadius },
      ]}>
      <Text
        style={[
          styles.bannerText,
          palette.font('bodyMedium', 14),
          { color: palette.onAccent(palette.danger) },
        ]}>
        {notice}
      </Text>
      <Pressable onPress={dismiss} hitSlop={8} accessibilityLabel={t(locale, 'close')}>
        <Text style={[palette.font('bodyBold', 14), { color: palette.onAccent(palette.danger) }]}>
          ✕
        </Text>
      </Pressable>
    </View>
  );
}

export function BannerAnchor({ palette }: { palette: Palette }) {
  return (
    <View pointerEvents="box-none" style={styles.anchor}>
      <Banner palette={palette} />
    </View>
  );
}

const styles = StyleSheet.create({
  // Zero-height anchor: the banner floats down from here without taking up layout space.
  anchor: { height: 0, zIndex: 50 },
  floating: {
    position: 'absolute',
    top: 8,
    zIndex: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingRight: 4,
    paddingVertical: 2,
    elevation: 6,
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  // Undo and close are at least 44 square points and non-overlapping, so tapping "Undo" does not land on "Close".
  action: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 8,
    paddingVertical: 12,
  },
  bannerText: { flex: 1 },
});
