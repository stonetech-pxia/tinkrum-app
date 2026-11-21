// 给别的 AI 自检用的检查器（D-611）：prebuild 时把 scripts/agent-kit/check-cli.ts 打成一个文件 tinkrum-check.js
// （和网站上的同一个，D-594），放进 App 的 agent/：iOS 是 .app 里的文件夹（folder reference），Android 是
// app/src/main/assets/agent。交给别的 AI App 时复制一份和 App 文件一起分享。检查的就是这个版本的 App 能导入什么。
const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod, withXcodeProject } = require('expo/config-plugins');

/** 仓库根目录（projectRoot 是 apps/mobile）。 */
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
      // 整个文件夹作为 folder reference 进 App 的资源（.app/agent/tinkrum-check.js），和扩展包一样（D-510）。
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
