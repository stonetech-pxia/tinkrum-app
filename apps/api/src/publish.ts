import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BUILTIN_TOOLS,
  CatalogSchema,
  applyOps,
  compareVersions,
  createDefaultWorkspace,
  createRegistry,
  generateSigningKey,
  parseToolManifest,
  publicKeyOf,
  registerTool,
  signCatalog,
  toolFromManifest,
  toolManifestUrl,
  validateWorkspace,
  verifyCatalog,
  type Catalog,
  type CatalogEntry,
  type ToolManifest,
} from '@morph/core';

// Publish downloaded tools (D-177, D-178, docs/TOOL_DOWNLOAD_DESIGN.md §9).
//    build: tools/<id>/manifest.json → <out>/tools/<id>/<version>.json + <out>/catalog.json (unsigned)
//    sign: sign <out>/catalog.json with private key on an offline machine → <out>/catalog.sig
//    revoke: write a version to the revocation list (requires re-signing afterward)
//    verify: re-check signature, size, and hash before upload
// The entire <out> directory is uploaded to hosting (Cloudflare R2); the hosting provider need not
// be trusted because all contents are signed.

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const readCatalog = (out: string): Catalog | null =>
  existsSync(join(out, 'catalog.json'))
    ? CatalogSchema.parse(JSON.parse(readFileSync(join(out, 'catalog.json'), 'utf8')))
    : null;
const writeCatalog = (out: string, catalog: Catalog) =>
  writeFileSync(join(out, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);

/**
 * The new version must accept old configurations (§5): add the old version in an empty workspace,
 * then validate with the new version. Quick actions already added by the user remain old-version
 * steps until "Update", and the new version must not cause them to fail validation.
 */
function compatibilityProblems(previous: ToolManifest, next: ToolManifest): string[] {
  const problems: string[] = [];
  for (const locale of ['en', 'zh'] as const) {
    const old = createRegistry(BUILTIN_TOOLS);
    registerTool(old, toolFromManifest(previous));
    const applied = applyOps(
      createDefaultWorkspace(locale),
      [{ op: 'setPackage', package: previous.id, do: 'add' }],
      { registry: old, locale },
    );
    if (!applied.ok) continue;
    const updated = createRegistry(BUILTIN_TOOLS);
    registerTool(updated, toolFromManifest(next));
    const valid = validateWorkspace(applied.config, updated);
    if (!valid.ok) problems.push(...valid.issues.map((i) => `${locale}: ${i.message}`));
  }
  return problems;
}

/**
 * Inspect each manifest under tools/, copy them into the output directory, and generate a new
 * catalog (seq incremented by 1, revocation list preserved). The version number must not be older
 * than published versions; content must not change when the version number remains unchanged
 * (already published files cannot be silently replaced).
 */
export function buildCatalog(toolsDir: string, out: string, now = new Date()): Catalog {
  const previous = readCatalog(out);
  const registry = createRegistry(BUILTIN_TOOLS);
  const entries: CatalogEntry[] = [];
  const problems: string[] = [];
  for (const id of readdirSync(toolsDir).sort()) {
    const file = join(toolsDir, id, 'manifest.json');
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    let manifest: ToolManifest;
    try {
      manifest = parseToolManifest(bytes, registry);
    } catch (e) {
      problems.push(`${id}: ${String(e)}`);
      continue;
    }
    if (manifest.id !== id) {
      problems.push(`${id}: the folder name must be the tool id (${manifest.id})`);
      continue;
    }
    const path = `tools/${manifest.id}/${manifest.version}.json`;
    const before = previous?.tools.find((e) => e.id === manifest.id);
    if (before) {
      const order = compareVersions(manifest.version, before.version);
      if (order < 0) problems.push(`${id}: ${manifest.version} is older than ${before.version}`);
      if (order === 0 && sha256(bytes) !== before.sha256) {
        problems.push(`${id}: ${manifest.version} was already published with other content`);
      }
      if (order > 0) {
        const old = JSON.parse(readFileSync(join(out, before.path), 'utf8')) as ToolManifest;
        problems.push(...compatibilityProblems(old, manifest).map((p) => `${id}: ${p}`));
      }
    }
    mkdirSync(join(out, 'tools', manifest.id), { recursive: true });
    writeFileSync(join(out, path), bytes);
    entries.push({
      id: manifest.id,
      version: manifest.version,
      hostApi: manifest.hostApi,
      path,
      size: bytes.length,
      sha256: sha256(bytes),
      name: manifest.name,
      description: manifest.description,
      icon: manifest.icon,
    });
  }
  // Published tools that are absent from the current tools/ directory must also be kept: users who have already added them still need them (planner service recognizes them via the catalog).
  for (const old of previous?.tools ?? []) {
    if (!entries.some((e) => e.id === old.id)) {
      problems.push(`${old.id}: was published before; keep it in tools/ (revoke it instead)`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
  const catalog: Catalog = {
    format: 1,
    seq: (previous?.seq ?? 0) + 1,
    issuedAt: now.toISOString(),
    tools: entries,
    revoked: previous?.revoked ?? [],
  };
  CatalogSchema.parse(catalog);
  mkdirSync(out, { recursive: true });
  writeCatalog(out, catalog);
  return catalog;
}

/** Revoke a version (id@version). After modifying the catalog, it must be re-signed. */
export function revokeVersion(out: string, idAtVersion: string, now = new Date()): Catalog {
  const catalog = readCatalog(out);
  if (!catalog) throw new Error('no catalog.json; run build first');
  const [id, version] = idAtVersion.split('@');
  const published = catalog.tools.some((e) => e.id === id);
  if (!published || !version) throw new Error(`${idAtVersion} is not a published tool version`);
  const next: Catalog = {
    ...catalog,
    seq: catalog.seq + 1,
    issuedAt: now.toISOString(),
    revoked: [...new Set([...catalog.revoked, idAtVersion])],
  };
  CatalogSchema.parse(next);
  writeCatalog(out, next);
  return next;
}

/** Read private key file: one line of base64, with lines starting with # as comments. */
export function readSecretKey(file: string): string {
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  if (!line) throw new Error(`${file} has no key`);
  return line;
}

/** Sign the catalog with a private key (base64) and return the public key for signing (verify against the one built into the app before publishing). */
export function signCatalogWithKey(out: string, secretKey: string): string {
  let publicKey: string;
  try {
    publicKey = publicKeyOf(secretKey);
  } catch {
    throw new Error('that is not a signing key (expected 44 characters of base64)');
  }
  const bytes = readFileSync(join(out, 'catalog.json'));
  writeFileSync(join(out, 'catalog.sig'), `${signCatalog(bytes, secretKey)}\n`);
  return publicKey;
}

/** Sign the catalog with a private key file (used like the dev key tools/dev-signing-key.txt). */
export function signCatalogFile(out: string, secretKeyFile: string): string {
  return signCatalogWithKey(out, readSecretKey(secretKeyFile));
}

/** Pre-upload check: signature, size and hash of each manifest, and ensure manifests fit into the built-in registry. */
export function verifyOutput(out: string, trustedKeys: readonly string[]): Catalog {
  const catalog = verifyCatalog(
    readFileSync(join(out, 'catalog.json')),
    readFileSync(join(out, 'catalog.sig'), 'utf8'),
    trustedKeys,
  );
  const registry = createRegistry(BUILTIN_TOOLS);
  for (const entry of catalog.tools) {
    const bytes = readFileSync(join(out, entry.path));
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
      throw new Error(`${entry.id}: ${toolManifestUrl('.', entry)} does not match the catalog`);
    }
    parseToolManifest(bytes, registry, entry);
  }
  return catalog;
}

/** Generate a new key pair: write private key to file (readable only by owner), and return the public key. */
export function keygen(file: string): string {
  if (existsSync(file)) throw new Error(`${file} already exists; not overwriting a key`);
  const { secretKey, publicKey } = generateSigningKey();
  writeFileSync(
    file,
    `# Morph 工具目录的签名私钥（D-178）。离线保管，不进仓库，不放在任何服务器上。\n${secretKey}\n`,
    { mode: 0o600 },
  );
  return publicKey;
}
