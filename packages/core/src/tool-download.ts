import { localize } from './localization';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { z } from 'zod';

import { createDefaultWorkspace } from './defaults';
import { blocksToV41 } from './migrate';
import { migratePageV33, migrateWorkflowV33, v33Tables } from './migrate-v34';
import { applyOps } from './ops';
import type { Registry, ToolDefinition } from './registry';
import {
  IconSchema,
  ListedIconValueSchema,
  IdSchema,
  WorkflowStepSchema,
  type Locale,
  type Page,
  type QuickAction,
} from './schema';
import { validateWorkspace } from './validate';
import { PERMISSIONS } from './workflow/contract';

// Tools downloaded from the server (D-177, D-178, docs/TOOL_DOWNLOAD_DESIGN.md). The first step
// includes data tools only: manifests contain tool page text and quick actions, combining existing
// actions only without any code. The catalog (`catalog.json`) is signed with Ed25519; manifests are
// validated against the SHA-256 in the catalog. Both the app and planning service share this
// validation.

ed.hashes.sha512 = sha512;

// Both Hermes and Node have atob / btoa (already used in the app); core lib has ES2022 only, so define types here.
declare function atob(data: string): string;
declare function btoa(data: string): string;

/**
 * Decode UTF-8 bytes into a string (avoid TextDecoder as it may not be present on Hermes).
 * Invalid bytes throw immediately, ensuring that decoding and re-encoding results in bytes
 * identical to the original (relied upon for catalog signatures).
 */
export function decodeUtf8(bytes: Uint8Array): string {
  const parts: string[] = [];
  const cont = (i: number) => {
    const b = bytes[i];
    if (b === undefined || (b & 0xc0) !== 0x80) throw new Error('invalid UTF-8');
    return b & 0x3f;
  };
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i]!;
    let cp: number;
    if (b < 0x80) {
      cp = b;
      i += 1;
    } else if (b >= 0xc2 && b < 0xe0) {
      cp = ((b & 0x1f) << 6) | cont(i + 1);
      i += 2;
    } else if (b >= 0xe0 && b < 0xf0) {
      cp = ((b & 0x0f) << 12) | (cont(i + 1) << 6) | cont(i + 2);
      if (cp < 0x800 || (cp >= 0xd800 && cp < 0xe000)) throw new Error('invalid UTF-8');
      i += 3;
    } else if (b >= 0xf0 && b < 0xf5) {
      cp = ((b & 0x07) << 18) | (cont(i + 1) << 12) | (cont(i + 2) << 6) | cont(i + 3);
      if (cp < 0x10000 || cp > 0x10ffff) throw new Error('invalid UTF-8');
      i += 4;
    } else {
      throw new Error('invalid UTF-8');
    }
    parts.push(String.fromCodePoint(cp));
  }
  return parts.join('');
}

/** Host capability level (§7): increments by 1 for each capability added to the app that downloaded tools can use. */
export const HOST_API = 1;

/** Maximum size limit for a single tool manifest (data tools contain text and steps only). */
export const MAX_TOOL_MANIFEST_BYTES = 256 * 1024;

const VersionSchema = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/, 'version must be x.y.z');

/** Compare two x.y.z version numbers: returns a positive number if `a` is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const localized = (max: number) =>
  z.strictObject({
    en: z.string().trim().min(1).max(max),
    zh: z.string().trim().min(1).max(max),
    fr: z.string().trim().min(1).max(max).optional(),
  });

export const ToolManifestSchema = z.strictObject({
  format: z.literal(1),
  id: IdSchema,
  version: VersionSchema,
  hostApi: z.number().int().min(1),
  /** 4.7.5: publish tools rated 4+ only. */
  ageRating: z.literal('4+'),
  name: localized(40),
  description: localized(200),
  /** A description paragraph below the tool page title. */
  intro: localized(300),
  icon: IconSchema,
  aliases: z.array(z.string().trim().min(1).max(40)).max(20),
  permissions: z.array(z.enum(PERMISSIONS)),
  workflows: z
    .array(
      z.strictObject({
        id: IdSchema,
        name: localized(40),
        icon: ListedIconValueSchema.optional(),
        steps: z.array(WorkflowStepSchema).min(1),
      }),
    )
    .min(1)
    .max(12),
  /** File list at the bottom of the tool page (optional). */
  fileList: z
    .strictObject({
      title: localized(40),
      limit: z.number().int().min(1).max(50),
      mimeType: z.enum(['application/pdf', 'image/*', 'video/*', 'audio/*']).optional(),
    })
    .optional(),
});
export type ToolManifest = z.infer<typeof ToolManifestSchema>;

const pick = (locale: Locale, text: { en: string; zh: string }) => localize(text, locale);

/**
 * Convert a manifest into a registry tool: formatted identically to tool pages and simple tools
 * (title, description, one run card per quick action). Server manifests (format 1) use v33
 * syntax: first construct pages and workflows using v33 layout, then migrate via v34 migration
 * (`migrate-v34.ts`, using the same conversion logic as local config and templates; fileList's
 * mimeType becomes $files' kind filter).
 */
export function toolFromManifest(manifest: ToolManifest): ToolDefinition {
  const pageId = `tool-${manifest.id}`;
  const createWorkflows = (locale: Locale): QuickAction[] =>
    manifest.workflows.map(
      (wf) =>
        migrateWorkflowV33({
          id: wf.id,
          name: pick(locale, wf.name),
          ...(wf.icon ? { icon: wf.icon } : {}),
          toolId: manifest.id,
          steps: JSON.parse(JSON.stringify(wf.steps)) as QuickAction['steps'],
        }) as QuickAction,
    );
  // Built in the v33 shape, then brought to v34 and to v41 (one button that runs each quick action).
  const createPage = (locale: Locale): Page => {
    const page = migratePageV33(
      {
        id: pageId,
        title: pick(locale, manifest.name),
        icon: manifest.icon,
        toolId: manifest.id,
        components: [
          {
            id: `${manifest.id}-header`,
            type: 'header',
            props: { title: pick(locale, manifest.name) },
          },
          {
            id: `${manifest.id}-intro`,
            type: 'text',
            props: { text: pick(locale, manifest.intro) },
          },
          ...manifest.workflows.map((wf) => ({
            id: `${wf.id}-runner`,
            type: 'workflowRunner',
            props: { workflowId: wf.id },
          })),
          ...(manifest.fileList
            ? [
                {
                  id: `${manifest.id}-files`,
                  type: 'fileList',
                  props: {
                    title: pick(locale, manifest.fileList.title),
                    limit: manifest.fileList.limit,
                    ...(manifest.fileList.mimeType ? { mimeType: manifest.fileList.mimeType } : {}),
                  },
                },
              ]
            : []),
        ],
      },
      // No table reading blocks on the tool page.
      v33Tables([]),
    ) as Page;
    return { ...page, blocks: blocksToV41(page.blocks) as Page['blocks'] };
  };
  return {
    id: manifest.id,
    version: manifest.version,
    name: { ...manifest.name, fr: manifest.name.fr ?? manifest.name.en },
    description: {
      ...manifest.description,
      fr: manifest.description.fr ?? manifest.description.en,
    },
    icon: manifest.icon,
    aliases: manifest.aliases.map((a) => a.toLowerCase()),
    permissions: manifest.permissions,
    actions: [],
    createPage,
    createWorkflows,
    origin: 'download',
  };
}

/**
 * Check whether a manifest can be installed into this registry: must not share names with
 * built-in tools, app capability level must be sufficient, quick action IDs must start with the
 * tool ID, and when added to an empty workspace (in both languages) must pass validateWorkspace
 * (actions, parameters, type chains, permissions).
 */
export function checkToolManifest(manifest: ToolManifest, registry: Registry): string[] {
  const problems: string[] = [];
  const existing = registry.tools.get(manifest.id);
  if (existing && existing.origin !== 'download')
    problems.push(`${manifest.id} is a built-in tool`);
  if (manifest.hostApi > HOST_API) {
    problems.push(`needs host API ${manifest.hostApi}, this app has ${HOST_API}`);
  }
  const ids = manifest.workflows.map((wf) => wf.id);
  for (const id of ids) {
    if (!id.startsWith(`${manifest.id}-`))
      problems.push(`workflow ${id} must start with ${manifest.id}-`);
  }
  if (new Set(ids).size !== ids.length) problems.push('duplicate workflow ids');
  if (problems.length > 0) return problems;

  const tool = toolFromManifest(manifest);
  const scratch: Registry = {
    tools: new Map([...registry.tools, [tool.id, tool]]),
    actions: registry.actions,
    actionOwner: registry.actionOwner,
  };
  for (const locale of ['en', 'zh'] as const) {
    const applied = applyOps(
      createDefaultWorkspace(locale),
      [{ op: 'setPackage', package: tool.id, do: 'add' }],
      { registry: scratch, locale },
    );
    if (!applied.ok) {
      problems.push(`${locale}: ${applied.error}`);
      continue;
    }
    const valid = validateWorkspace(applied.config, scratch);
    if (!valid.ok) problems.push(...valid.issues.map((i) => `${locale}: ${i.message}`));
  }
  return problems;
}

/** Parse and check a downloaded manifest; throws `ToolDownloadError` if invalid. */
export function parseToolManifest(
  bytes: Uint8Array,
  registry: Registry,
  expected?: { id: string; version: string },
): ToolManifest {
  let json: unknown;
  try {
    json = JSON.parse(decodeUtf8(bytes));
  } catch {
    throw new ToolDownloadError('format', 'manifest is not JSON');
  }
  const parsed = ToolManifestSchema.safeParse(json);
  if (!parsed.success) throw new ToolDownloadError('format', parsed.error.issues[0]?.message);
  const manifest = parsed.data;
  if (expected && (manifest.id !== expected.id || manifest.version !== expected.version)) {
    throw new ToolDownloadError('format', `expected ${expected.id}@${expected.version}`);
  }
  const problems = checkToolManifest(manifest, registry);
  if (problems.length > 0) throw new ToolDownloadError('invalid', problems.join('; '));
  return manifest;
}

// ---- Signed catalog ----

export const CatalogEntrySchema = z.strictObject({
  id: IdSchema,
  version: VersionSchema,
  hostApi: z.number().int().min(1),
  /** Path of the manifest relative to the catalog URL, e.g., `tools/rental/1.0.0.json`. */
  path: z
    .string()
    .regex(/^[a-z0-9][a-z0-9/._-]*\.json$/, 'path must be a relative .json path')
    .refine((p) => !p.includes('..'), 'path must not contain ..'),
  size: z.number().int().min(1).max(MAX_TOOL_MANIFEST_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  // Displayed on the catalog page before downloading.
  name: localized(40),
  description: localized(200),
  icon: IconSchema,
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const CatalogSchema = z.strictObject({
  format: z.literal(1),
  /** Increments with each release; the app rejects values smaller than last seen (prevents rollback attacks using old catalogs). */
  seq: z.number().int().min(1),
  issuedAt: z.iso.datetime(),
  /** Latest version of each tool (deprecated ones remain here as well, otherwise configurations already using them would fail validation). */
  tools: z.array(CatalogEntrySchema).max(500),
  /** Revoked versions: format `"id@version"`. */
  revoked: z.array(z.string().regex(/^[a-z0-9-]+@\d+\.\d+\.\d+$/)).max(1000),
});
export type Catalog = z.infer<typeof CatalogSchema>;

export class ToolDownloadError extends Error {
  constructor(
    readonly code:
      | 'signature'
      | 'format'
      | 'stale'
      | 'download'
      | 'size'
      | 'hash'
      | 'invalid'
      | 'downgrade'
      | 'host',
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const toBase64 = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text.trim()), (c: string) => c.charCodeAt(0));

/** Sign the catalog with the private key (used by publishing scripts and tests), returning a base64 signature. */
export function signCatalog(bytes: Uint8Array, secretKeyBase64: string): string {
  return toBase64(ed.sign(bytes, fromBase64(secretKeyBase64)));
}

/** Public key corresponding to the private key (base64). */
export function publicKeyOf(secretKeyBase64: string): string {
  return toBase64(ed.getPublicKey(fromBase64(secretKeyBase64)));
}

/** Generate a new key pair (base64). */
export function generateSigningKey(): { secretKey: string; publicKey: string } {
  const { secretKey, publicKey } = ed.keygen();
  return { secretKey: toBase64(secretKey), publicKey: toBase64(publicKey) };
}

/**
 * Verify catalog signature (passes if verified by any trusted public key), then parse. `minSeq`:
 * minimum acceptable catalog sequence number from last seen; rejects if smaller.
 */
export function verifyCatalog(
  bytes: Uint8Array,
  signatureBase64: string,
  trustedKeys: readonly string[],
  minSeq = 0,
): Catalog {
  let signature: Uint8Array;
  try {
    signature = fromBase64(signatureBase64);
  } catch {
    throw new ToolDownloadError('signature', 'not base64');
  }
  const ok = trustedKeys.some((key) => {
    try {
      return ed.verify(signature, bytes, fromBase64(key));
    } catch {
      return false;
    }
  });
  if (!ok) throw new ToolDownloadError('signature');
  let json: unknown;
  try {
    json = JSON.parse(decodeUtf8(bytes));
  } catch {
    throw new ToolDownloadError('format', 'catalog is not JSON');
  }
  const parsed = CatalogSchema.safeParse(json);
  if (!parsed.success) throw new ToolDownloadError('format', parsed.error.issues[0]?.message);
  if (parsed.data.seq < minSeq)
    throw new ToolDownloadError('stale', `seq ${parsed.data.seq} < ${minSeq}`);
  return parsed.data;
}

export const isRevoked = (catalog: Catalog | null, id: string, version: string) =>
  catalog?.revoked.includes(`${id}@${version}`) ?? false;

/** Manifest URL for a tool in the catalog (relative to the catalog base URL). */
export function toolManifestUrl(catalogBaseUrl: string, entry: CatalogEntry): string {
  return `${catalogBaseUrl.replace(/\/+$/, '')}/${entry.path}`;
}
