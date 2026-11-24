import {
  DEFAULT_MODEL,
  MODELS,
  checkBaseUrl,
  checkModelAccess,
  checkOpenAICompatible,
  listOpenAICompatibleModels,
  AIHttpError,
  type AIErrorKind,
} from '@morph/planner';
import { createStore, type StoreApi } from 'zustand/vanilla';

// AI settings (device-level, not part of workspace config, excluded from version history).
// User-provided API keys are stored in secure storage (iOS Keychain / Android Keystore) and used
// only locally. Two types of custom keys are supported (D-241): Anthropic, or OpenAI-compatible
// interfaces (user provides Base URL and model name). The keys for both are stored separately:
// Anthropic's key is sent exclusively to api.anthropic.com and will not be sent to user-provided
// custom endpoints due to switching.

export type AIMode = 'mock' | 'server' | 'byok';
export type ByokProvider = 'anthropic' | 'openai';

/** Secure storage interface: implemented via expo-secure-store in the App, and in-memory in tests. */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const KEYS = {
  apiKey: 'morph.ai.apiKey',
  keyHint: 'morph.ai.keyHint',
  mode: 'morph.ai.mode',
  model: 'morph.ai.model',
  provider: 'morph.ai.provider',
  openaiKey: 'morph.ai.openai.apiKey',
  openaiKeyHint: 'morph.ai.openai.keyHint',
  openaiBaseUrl: 'morph.ai.openai.baseUrl',
  openaiModel: 'morph.ai.openai.model',
  needsButton: 'morph.ai.needsButton',
};

/** A requirement submitted proactively by a user (D-189): contains only this text and metadata stripped of identity info. */
export interface Need {
  text: string;
  locale: 'en' | 'zh' | 'fr';
  reason: 'unknown' | 'errand' | 'notInstalled';
  ai: AIMode;
}

/** Send a requirement to Morph's server; returns true on success. */
export type NeedSender = (need: Need) => Promise<boolean>;

export type ConnectionResult =
  { ok: true } | { ok: false; kind: AIErrorKind | 'no_key' | 'no_endpoint' | 'network' };

export type ModelListResult =
  { ok: true; models: string[] } | { ok: false; kind: AIErrorKind | 'no_endpoint' | 'network' };

export type EndpointResult =
  { ok: true } | { ok: false; issue: 'invalid' | 'insecure' | 'no_model' };

export interface AISettingsState {
  loaded: boolean;
  mode: AIMode;
  /** Claude model used when using Anthropic. */
  model: string;
  provider: ByokProvider;
  /** Base URL and model name for OpenAI-compatible interfaces; empty string when not filled. */
  baseUrl: string;
  customModel: string;
  /** Last four characters of the saved key for the current provider, for display purposes; null when no key exists. */
  keyHint: string | null;
  /** Whether a Morph server endpoint is configured. */
  serverAvailable: boolean;
  /** Display "Send this feedback to us" when AI cannot handle it (D-189, shown by default; sent only upon tapping). */
  needsButton: boolean;
  /** Whether requirements can be sent (server URL is configured). */
  canSendNeeds: boolean;

  load(): Promise<void>;
  setMode(mode: AIMode): Promise<void>;
  setModel(model: string): Promise<void>;
  setProvider(provider: ByokProvider): Promise<void>;
  /** Save the endpoint URL and model name for OpenAI-compatible interfaces; delete the old key if the URL changes to avoid sending it to the new address. */
  saveEndpoint(baseUrl: string, model: string): Promise<EndpointResult>;
  setNeedsButton(on: boolean): Promise<void>;
  sendNeed(need: Omit<Need, 'ai'>): Promise<boolean>;
  /** Save the key for the current provider. */
  saveKey(key: string): Promise<boolean>;
  clearKey(): Promise<void>;
  /** Key for the current provider. */
  getKey(): Promise<string | null>;
  /** Request model list from the saved endpoint (sends only the key, no data); applicable only to OpenAI-compatible interfaces. */
  listModels(): Promise<ModelListResult>;
  testConnection(): Promise<ConnectionResult>;
}

export type AISettingsStore = StoreApi<AISettingsState>;

/** Rough format check to avoid storing obvious non-keys. Actual usability is determined by 'test connection'. */
export const looksLikeApiKey = (key: string) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key);
/** Key formats vary by provider; only requires no whitespace and not too short. */
export const looksLikeOtherApiKey = (key: string) => /^[\x21-\x7e]{8,}$/.test(key);

const keySlot = (provider: ByokProvider) =>
  provider === 'anthropic'
    ? { key: KEYS.apiKey, hint: KEYS.keyHint }
    : { key: KEYS.openaiKey, hint: KEYS.openaiKeyHint };

export function createAISettingsStore(deps: {
  secrets: SecretStore;
  serverAvailable: boolean;
  fetchImpl?: typeof fetch;
  needs?: NeedSender | null;
}): AISettingsStore {
  const { secrets } = deps;
  const defaultMode: AIMode = deps.serverAvailable ? 'server' : 'mock';
  return createStore<AISettingsState>()((set, get) => ({
    loaded: false,
    mode: defaultMode,
    model: DEFAULT_MODEL,
    provider: 'anthropic',
    baseUrl: '',
    customModel: '',
    keyHint: null,
    serverAvailable: deps.serverAvailable,
    needsButton: true,
    canSendNeeds: Boolean(deps.needs),

    async load() {
      const [mode, model, needsButton, storedProvider, baseUrl, customModel] = await Promise.all([
        secrets.get(KEYS.mode),
        secrets.get(KEYS.model),
        secrets.get(KEYS.needsButton),
        secrets.get(KEYS.provider),
        secrets.get(KEYS.openaiBaseUrl),
        secrets.get(KEYS.openaiModel),
      ]);
      const provider: ByokProvider = storedProvider === 'openai' ? 'openai' : 'anthropic';
      const keyHint = await secrets.get(keySlot(provider).hint);
      const validMode =
        mode === 'mock' || mode === 'byok' || (mode === 'server' && deps.serverAvailable)
          ? mode
          : defaultMode;
      set({
        loaded: true,
        mode: validMode,
        model: MODELS.some((m) => m.id === model) ? model! : DEFAULT_MODEL,
        provider,
        baseUrl: baseUrl ?? '',
        customModel: customModel ?? '',
        keyHint,
        needsButton: needsButton !== 'off',
      });
    },

    async setNeedsButton(on) {
      await secrets.set(KEYS.needsButton, on ? 'on' : 'off');
      set({ needsButton: on });
    },

    async sendNeed(need) {
      if (!deps.needs) return false;
      return deps.needs({ ...need, ai: get().mode });
    },

    async setMode(mode) {
      if (mode === 'server' && !deps.serverAvailable) return;
      await secrets.set(KEYS.mode, mode);
      set({ mode });
    },

    async setModel(model) {
      if (!MODELS.some((m) => m.id === model)) return;
      await secrets.set(KEYS.model, model);
      set({ model });
    },

    async setProvider(provider) {
      await secrets.set(KEYS.provider, provider);
      set({ provider, keyHint: await secrets.get(keySlot(provider).hint) });
    },

    async saveEndpoint(rawUrl, rawModel) {
      const checked = checkBaseUrl(rawUrl);
      if (!checked.ok) return checked;
      const model = rawModel.trim();
      if (!model) return { ok: false, issue: 'no_model' };
      if (get().baseUrl && checked.url !== get().baseUrl) {
        const slot = keySlot('openai');
        await secrets.delete(slot.key);
        await secrets.delete(slot.hint);
        if (get().provider === 'openai') set({ keyHint: null });
      }
      await secrets.set(KEYS.openaiBaseUrl, checked.url);
      await secrets.set(KEYS.openaiModel, model);
      set({ baseUrl: checked.url, customModel: model });
      return { ok: true };
    },

    async saveKey(raw) {
      const key = raw.trim();
      const { provider } = get();
      if (!(provider === 'anthropic' ? looksLikeApiKey : looksLikeOtherApiKey)(key)) return false;
      const slot = keySlot(provider);
      await secrets.set(slot.key, key);
      await secrets.set(slot.hint, key.slice(-4));
      set({ keyHint: key.slice(-4) });
      return true;
    },

    async clearKey() {
      const slot = keySlot(get().provider);
      await secrets.delete(slot.key);
      await secrets.delete(slot.hint);
      set({ keyHint: null });
    },

    getKey: () => secrets.get(keySlot(get().provider).key),

    async listModels() {
      const { provider, baseUrl } = get();
      if (provider !== 'openai' || !baseUrl) return { ok: false, kind: 'no_endpoint' };
      try {
        const models = await listOpenAICompatibleModels({
          baseUrl,
          apiKey: await get().getKey(),
          timeoutMs: 15_000,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        });
        return { ok: true, models };
      } catch (e) {
        return { ok: false, kind: e instanceof AIHttpError ? e.kind : 'network' };
      }
    },

    async testConnection() {
      const { provider, baseUrl, customModel } = get();
      const apiKey = await get().getKey();
      const transport = {
        timeoutMs: 15_000,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      };
      try {
        if (provider === 'openai') {
          // Local models can leave the API key empty.
          if (!baseUrl || !customModel) return { ok: false, kind: 'no_endpoint' };
          await checkOpenAICompatible(customModel, { baseUrl, apiKey, ...transport });
          return { ok: true };
        }
        if (!apiKey) return { ok: false, kind: 'no_key' };
        await checkModelAccess(get().model, { apiKey, ...transport });
        return { ok: true };
      } catch (e) {
        return { ok: false, kind: e instanceof AIHttpError ? e.kind : 'network' };
      }
    },
  }));
}
