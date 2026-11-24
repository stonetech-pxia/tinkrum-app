import { RunError, type AskRequest, type Locale, type PackNeed } from '@morph/core';
import { useState, type ComponentType, type ReactNode } from 'react';
import { Alert, Platform } from 'react-native';

import { FullScreenModal } from '../renderer/Overlays';
import { t } from '../i18n';
import { ensureRunPacks } from '../packs/file-bundle';
import { PackGate } from '../packs/PackGate';
import { usePacks } from '../packs/PackHost';
import type { Palette } from '../renderer/theme';
import { AskPanel } from '../run/AskPanel';
import { LOCAL_SCREENS } from '../run/local';
import type { LocalScreenProps } from '../run/RunScreen';
import type { LocalKind, LocalSteps, LocalUi } from '../runtime/local';
import type { RunContext } from '../runtime/runner';

// If multiple places request closing at the same time (e.g. tapped tool and then left): close only
// once.

/** /** How long the prompt dialog fade-out takes (in milliseconds). * / */
const ASK_DISMISS_MS = 400;

interface Pending<T> {
  resolve: (value: T) => void;
}

type LocalPending = {
  [K in LocalKind]: { kind: K; input: LocalSteps[K]['in'] } & Pending<LocalSteps[K]['out'] | null>;
}[LocalKind];

export type RunHost = Required<
  Pick<RunContext, 'ui' | 'askParams' | 'ensurePack' | 'ensurePacks' | 'packs'>
> & { elements: ReactNode };

export function useRunHost(palette: Palette, locale: Locale): RunHost {
  const packs = usePacks();
  const [ask, setAsk] = useState<(AskRequest & Pending<Record<string, unknown> | null>) | null>(
    null,
  );
  const [packAsk, setPackAsk] = useState<
    ({ needs: readonly PackNeed[] } & Pending<string[] | null>) | null
  >(null);
  const [local, setLocal] = useState<LocalPending | null>(null);

  const ui: LocalUi = {
    confirm: (title, ok, cancel, message) =>
      new Promise((resolve) =>
        Alert.alert(
          title,
          message,
          [
            { text: cancel, style: 'cancel', onPress: () => resolve(false) },
            { text: ok, onPress: () => resolve(true) },
          ],
          { cancelable: false },
        ),
      ),
    choose: (title, message, options) =>
      new Promise((resolve) =>
        Alert.alert(
          title,
          message,
          [
            ...options.map((text, i) => ({ text, onPress: () => resolve(i) })),
            { text: t(locale, 'cancel'), style: 'cancel' as const, onPress: () => resolve(null) },
          ],
          { cancelable: false },
        ),
      ),
    open: (kind, input) =>
      new Promise((resolve) => setLocal({ kind, input, resolve } as unknown as LocalPending)),
  };

  const LocalScreen = local
    ? (LOCAL_SCREENS[local.kind] as ComponentType<LocalScreenProps<LocalKind>> | undefined)
    : undefined;

  const elements = (
    <>
      {ask ? (
        <AskPanel
          request={ask}
          palette={palette}
          locale={locale}
          now={new Date()}
          onAnswer={(answer) => {
            setAsk(null);
            // Quick actions handed over by rooms, run pages, and records share a common system interface (D-360, D-428): runtime prompts, pack downloads, and local editing. The host only collects user answers and local results, leaving subsequent workflows to the caller.
            if (Platform.OS === 'ios') setTimeout(() => ask.resolve(answer), ASK_DISMISS_MS);
            else ask.resolve(answer);
          }}
        />
      ) : null}
      {packAsk && packs ? (
        <PackGate
          needs={packAsk.needs}
          store={packs.store}
          palette={palette}
          locale={locale}
          onDone={(left) => {
            packAsk.resolve(left);
            setPackAsk(null);
          }}
        />
      ) : null}
      {local && LocalScreen ? (
        <FullScreenModal
          visible
          animationType="slide"
          onClose={() => {
            local.resolve(null);
            setLocal(null);
          }}>
          <LocalScreen
            input={local.input}
            palette={palette}
            locale={locale}
            onDone={(out) => {
              (local.resolve as (v: unknown) => void)(out);
              setLocal(null);
            }}
            onCancel={() => {
              local.resolve(null);
              setLocal(null);
            }}
          />
        </FullScreenModal>
      ) : null}
    </>
  );

  return {
    ui,
    elements,
    packs: packs
      ? { runtime: packs.bridge, isInstalled: (id) => packs.store.isInstalled(id) }
      : null,
    askParams: (request) => new Promise((resolve) => setAsk({ ...request, resolve })),
    ensurePacks: async (needs) => {
      if (!packs) throw new RunError('packFailed', { detail: needs[0]?.pack });
      // How long the prompt dialog fade-out takes (in milliseconds).
      return ensureRunPacks(
        packs.store,
        needs,
        (ask) => new Promise((resolve) => setPackAsk({ needs: ask, resolve })),
      );
    },
    ensurePack: async (packId, options) => {
      if (!packs) throw new RunError('packFailed', { detail: packId });
      if (await packs.store.isInstalled(packId)) return true;
      // If the system picker is opened while the iOS prompt dialog is still fading out, the picker is silently discarded by the system; wait for it to finish closing before proceeding.
      if (options?.optional === true) return false;
      const left = await new Promise<string[] | null>((resolve) =>
        setPackAsk({ needs: [{ pack: packId, optional: options?.optional === true }], resolve }),
      );
      return left !== null && !left.includes(packId);
    },
  };
}
