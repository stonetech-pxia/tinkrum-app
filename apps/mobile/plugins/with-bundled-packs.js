// Extension packs bundled with the app (D-510): during prebuild, downloads files in BUNDLED_PACKS
// according to packages/core/src/packs.ts manifest, verifies size and SHA-256 for each (cached in
// node_modules/.cache/morph-bundled-packs to avoid re-downloading on subsequent prebuilds), and
// places them into packs/<id>/<version>/ within the app: a folder reference inside the .app bundle
// on Xcode for iOS, and app/src/main/assets/packs on Android. Copied to documentDirectory/packs
// (src/packs/store.ts) the first time the app uses them. Extension packs hosted on our own server
// (layouts, flat packs, D-274) require EXPO_PUBLIC_MORPH_PACKS_URL; skipped when unconfigured (the
// app does not prompt to download them). Prebuild fails if a download fails or if the size or hash
// is incorrect, preventing the generation of an app missing extension packs.
const { Buffer } = require('node:buffer');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod, withXcodeProject } = require('expo/config-plugins');

/** Repository root directory (projectRoot is apps/mobile). */
const repoOf = (projectRoot) => path.resolve(projectRoot, '../..');

/** Manifest is written in TypeScript: directly readable by Node 22.18+ (stripping types). Read only during prebuild. */
function manifest(repo) {
  try {
    return require(path.join(repo, 'packages/core/src/packs.ts'));
  } catch (e) {
    throw new Error(
      `[with-bundled-packs] cannot read packages/core/src/packs.ts (needs Node 22.18+): ${e.message}`,
    );
  }
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** A single file: uses cache if present and hash matches; otherwise downloads, validates, and stores it in cache. Returns the cached path. */
async function fetchFile(repo, pack, file, url) {
  const cached = path.join(
    repo,
    'node_modules/.cache/morph-bundled-packs',
    pack.id,
    pack.version,
    file.path,
  );
  if (fs.existsSync(cached) && sha256(fs.readFileSync(cached)) === file.sha256) return cached;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`[with-bundled-packs] ${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== file.size || sha256(bytes) !== file.sha256) {
    throw new Error(`[with-bundled-packs] ${pack.id}/${file.path}: size or SHA-256 does not match`);
  }
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, bytes);
  return cached;
}

/** Place the extension packs required for this platform into dest (clears first so old versions are not left behind). */
async function bundlePacks(repo, platform, dest) {
  const { BUNDLED_PACKS, packById, packFileUrl } = manifest(repo);
  const base = process.env.EXPO_PUBLIC_MORPH_PACKS_URL;
  fs.rmSync(dest, { recursive: true, force: true });
  let total = 0;
  for (const id of BUNDLED_PACKS[platform]) {
    const pack = packById(id);
    if (!pack) throw new Error(`[with-bundled-packs] unknown pack ${id}`);
    const urls = pack.files.map((file) => packFileUrl(file, base));
    if (urls.some((url) => url === null)) {
      console.warn(
        `[with-bundled-packs] ${id} skipped: EXPO_PUBLIC_MORPH_PACKS_URL is not set (the app will not offer it either)`,
      );
      continue;
    }
    for (const [i, file] of pack.files.entries()) {
      const cached = await fetchFile(repo, pack, file, urls[i]);
      const target = path.join(dest, pack.id, pack.version, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(cached, target);
      total += file.size;
    }
  }
  console.log(
    `[with-bundled-packs] ${platform}: ${(total / 1024 / 1024).toFixed(1)} MB in ${dest}`,
  );
}

const withIosPacks = (config) =>
  withXcodeProject(
    withDangerousMod(config, [
      'ios',
      async (next) => {
        const { platformProjectRoot, projectName, projectRoot } = next.modRequest;
        const dest = path.join(platformProjectRoot, projectName, 'packs');
        await bundlePacks(repoOf(projectRoot), 'ios', dest);
        return next;
      },
    ]),
    (next) => {
      // Add the entire folder as a folder reference into app resources (.app/packs/...), preserving internal folder structure as-is.
      const project = next.modResults;
      const name = next.modRequest.projectName;
      const group = project.findPBXGroupKey({ name }) ?? project.findPBXGroupKey({ path: name });
      if (!group) throw new Error(`[with-bundled-packs] Xcode group ${name} not found`);
      const file = project.addResourceFile(
        `${name}/packs`,
        { lastKnownFileType: 'folder', target: project.getFirstTarget().uuid },
        group,
      );
      // Returns false if already added (prebuild without --clean). Folders have no encoding; removes empty fields written as "undefined" by the Xcode library.
      const ref = file && project.pbxFileReferenceSection()[file.fileRef];
      for (const key of Object.keys(ref ?? {})) if (ref[key] === undefined) delete ref[key];
      return next;
    },
  );

const withAndroidPacks = (config) =>
  withDangerousMod(config, [
    'android',
    async (next) => {
      const { platformProjectRoot, projectRoot } = next.modRequest;
      const dest = path.join(platformProjectRoot, 'app/src/main/assets/packs');
      await bundlePacks(repoOf(projectRoot), 'android', dest);
      return next;
    },
  ]);

module.exports = (config) => withAndroidPacks(withIosPacks(config));
