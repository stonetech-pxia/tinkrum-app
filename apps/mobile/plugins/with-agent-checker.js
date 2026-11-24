// Checker for self-inspection by other AIs (D-611): bundles scripts/agent-kit/check-cli.ts into a
// single file tinkrum-check.js during prebuild (same as on the website, D-594), placing it along
// with the guide and patterns into the app's agent/ folder: on iOS a folder reference inside .app,
// on Android app/src/main/assets/agent. Shared alongside app files when handing over to another AI
// app. Checks what formats this app version can import.
const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod, withXcodeProject } = require('expo/config-plugins');

/** Repository root directory (projectRoot is apps/mobile). */
const repoOf = (projectRoot) => path.resolve(projectRoot, '../..');

async function buildChecker(projectRoot, dest) {
  const repo = repoOf(projectRoot);
  const { build } = require(require.resolve('esbuild', { paths: [repo] }));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  await build({
    entryPoints: [path.join(repo, 'scripts', 'agent-kit', 'check-cli.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    minify: true,
    legalComments: 'none',
    banner: {
      js: '#!/usr/bin/env node\n// Tinkrum app-file checker: node tinkrum-check.js app.json',
    },
    outfile: path.join(dest, 'tinkrum-check.js'),
    logLevel: 'warning',
  });
  // Packaged together with the checker, ensuring the documentation matches the formats actually importable by the mobile app.
  for (const file of ['tinkrum-app-guide.md', 'tinkrum-app-patterns.md'])
    fs.copyFileSync(path.join(repo, 'docs', 'agent', file), path.join(dest, file));
  const size = fs.statSync(path.join(dest, 'tinkrum-check.js')).size;
  console.log(`[with-agent-checker] ${(size / 1024 / 1024).toFixed(1)} MB in ${dest}`);
}

const withIosChecker = (config) =>
  withXcodeProject(
    withDangerousMod(config, [
      'ios',
      async (next) => {
        const { platformProjectRoot, projectName, projectRoot } = next.modRequest;
        await buildChecker(projectRoot, path.join(platformProjectRoot, projectName, 'agent'));
        return next;
      },
    ]),
    (next) => {
      // Add the entire directory as a folder reference into app resources (.app/agent/tinkrum-check.js), similar to extension packs (D-510).
      const project = next.modResults;
      const name = next.modRequest.projectName;
      const group = project.findPBXGroupKey({ name }) ?? project.findPBXGroupKey({ path: name });
      if (!group) throw new Error(`[with-agent-checker] Xcode group ${name} not found`);
      const file = project.addResourceFile(
        `${name}/agent`,
        { lastKnownFileType: 'folder', target: project.getFirstTarget().uuid },
        group,
      );
      const ref = file && project.pbxFileReferenceSection()[file.fileRef];
      for (const key of Object.keys(ref ?? {})) if (ref[key] === undefined) delete ref[key];
      return next;
    },
  );

const withAndroidChecker = (config) =>
  withDangerousMod(config, [
    'android',
    async (next) => {
      const { platformProjectRoot, projectRoot } = next.modRequest;
      await buildChecker(projectRoot, path.join(platformProjectRoot, 'app/src/main/assets/agent'));
      return next;
    },
  ]);

module.exports = (config) => withAndroidChecker(withIosChecker(config));
