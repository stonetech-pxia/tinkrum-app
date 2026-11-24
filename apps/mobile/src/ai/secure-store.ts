import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import type { SecretStore } from './settings';

// Readable only when the device is unlocked and does not migrate to other devices with backups.
const OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export const secureSecretStore: SecretStore = {
  get: (key) => SecureStore.getItemAsync(key, OPTIONS),
  set: (key, value) => SecureStore.setItemAsync(key, value, OPTIONS),
  delete: (key) => SecureStore.deleteItemAsync(key, OPTIONS),
};

// Used only for Morph server rate limiting per device (D-132): randomly generated on first use, contains no device information.
let deviceId: Promise<string | null> | undefined;
export function getDeviceId(): Promise<string | null> {
  deviceId ??= (async () => {
    const saved = await secureSecretStore.get('morph.deviceId');
    if (saved) return saved;
    const fresh = randomUUID();
    await secureSecretStore.set('morph.deviceId', fresh);
    return fresh;
  })().catch(() => null);
  return deviceId;
}
