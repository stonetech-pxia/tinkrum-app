// 整体导出和恢复用的 zip 读写（apps/mobile/modules/morph-archive，D-600）：iOS 的 Swift 实现单独编译，
// 和 unzip、python 的 zipfile 互相核对（它们写的包要读得出来，恶意的包要拒绝；我们写的包它们要认）。
// 只在 macOS 上、有 swiftc 和 python3 时跑；只在系统临时目录编译和运行。
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = 'apps/mobile/modules/morph-archive';
const have = (cmd, arg) => spawnSync(cmd, [arg], { encoding: 'utf8' }).status === 0;
if (
  process.platform !== 'darwin' ||
  !have('swiftc', '--version') ||
  !have('python3', '--version')
) {
  console.log('skipped: needs macOS with swiftc and python3');
  process.exit(0);
}

const PY_SAMPLES = String.raw`
import sys, zipfile, os, struct, zlib, random
d = sys.argv[1]
def w(name, entries, method=zipfile.ZIP_DEFLATED, force64=False):
    with zipfile.ZipFile(os.path.join(d, name), 'w', method) as z:
        for n, data in entries:
            if force64:
                with z.open(n, 'w', force_zip64=True) as f:
                    f.write(data)
            else:
                z.writestr(n, data)
hello = ('hello 你好\n').encode()
base = [('tinkrum-backup.json', b'{}'), ('files/hello.txt', hello)]
w('ok-deflate.zip', base)
w('ok-stored.zip', base, zipfile.ZIP_STORED)
w('ok-zip64.zip', base, force64=True)
w('bad-dotdot.zip', base + [('files/../../evil.txt', b'x')])
w('bad-absolute.zip', base + [('/etc/evil.txt', b'x')])
w('bad-backslash.zip', base + [('files\\evil.txt', b'x')])
w('bad-duplicate.zip', base + [('files/Hello.txt', b'x')])
with zipfile.ZipFile(os.path.join(d, 'bad-symlink.zip'), 'w') as z:
    z.writestr('files/hello.txt', hello)
    i = zipfile.ZipInfo('files/link'); i.create_system = 3; i.external_attr = 0o120777 << 16
    z.writestr(i, '/etc/passwd')
def patch(src, dst, off, fmt, value):
    b = bytearray(open(os.path.join(d, src), 'rb').read())
    c = b.find(b'PK\x01\x02')
    struct.pack_into(fmt, b, c + off, value)
    open(os.path.join(d, dst), 'wb').write(b)
patch('ok-deflate.zip', 'bad-encrypted.zip', 8, '<H', 1)
patch('ok-deflate.zip', 'bad-method.zip', 10, '<H', 12)
b = open(os.path.join(d, 'ok-deflate.zip'), 'rb').read()
open(os.path.join(d, 'bad-truncated.zip'), 'wb').write(b[: len(b) // 2])
open(os.path.join(d, 'bad-notzip.zip'), 'wb').write(os.urandom(5000))
# 内容被改（存储方式，校验和对不上）
w('tmp-crc.zip', [('files/hello.txt', hello)], zipfile.ZIP_STORED)
b = bytearray(open(os.path.join(d, 'tmp-crc.zip'), 'rb').read())
b[b.find(b'hello \xe4') + 1] ^= 0xFF
open(os.path.join(d, 'bad-crc.zip'), 'wb').write(b)
# 声明的大小和实际不符：写 ok 的，再把中央目录里的大小改了（第 2 条 files/hello.txt）
w('tmp-size.zip', [('files/hello.txt', hello)])
for name, value in (('bad-size-lie.zip', 1000), ('bad-bomb-lie.zip', 2)):
    b = bytearray(open(os.path.join(d, 'tmp-size.zip'), 'rb').read())
    c = b.find(b'PK\x01\x02')
    struct.pack_into('<I', b, c + 24, value)
    open(os.path.join(d, name), 'wb').write(b)
# 本地头也要对得上：bomb 那条只改中央目录，解压时会产出比声明多的字节。
`;

const PY_VERIFY = String.raw`
import sys, zipfile
for p in sys.argv[1:]:
    z = zipfile.ZipFile(p)
    assert z.testzip() is None, p
    names = z.namelist()
    assert 'database/morph.db' in names and 'files/assets/ab12/合同 (final).pdf' in names, names
    assert all(z.getinfo(n).file_size >= 0 for n in names)
`;

// Gradle 缓存里的 Kotlin 编译器和 JDK 17（没有就跳过 Kotlin 部分）。
function kotlinToolchain() {
  const gradle = path.join(homedir(), '.gradle/caches/modules-2/files-2.1');
  const jdkHome = process.env.JAVA_HOME || path.join(homedir(), 'development/jdk-17/Contents/Home');
  const java = path.join(jdkHome, 'bin/java');
  if (!existsSync(java) || !existsSync(gradle)) return null;
  const find = (group, artifact, version) => {
    const base = path.join(gradle, group, artifact, version);
    if (!existsSync(base)) return null;
    for (const hash of readdirSync(base)) {
      const jar = path.join(base, hash, `${artifact}-${version}.jar`);
      if (existsSync(jar)) return jar;
    }
    return null;
  };
  const parts = [
    find('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '2.2.21'),
    find('org.jetbrains.kotlin', 'kotlin-stdlib', '2.2.21'),
    find('org.jetbrains.kotlin', 'kotlin-script-runtime', '2.2.21'),
    find('org.jetbrains.kotlin', 'kotlin-reflect', '1.6.10'),
    find('org.jetbrains.kotlin', 'kotlin-daemon-embeddable', '2.2.21'),
    find('org.jetbrains', 'annotations', '13.0'),
    find('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.8.0'),
  ];
  const trove =
    find('org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330') ||
    find('org.jetbrains.intellij.deps', 'trove4j', '1.0.20181211');
  if (parts.some((p) => !p) || !trove) return null;
  return { java, stdlib: parts[1], compilerClasspath: [...parts, trove].join(path.delimiter) };
}

const dir = mkdtempSync(path.join(tmpdir(), 'morph-archive-test-'));
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')}\n${r.stderr || r.error?.message || ''}`);
};
try {
  const samples = path.join(dir, 'samples');
  const work = path.join(dir, 'work');
  run('mkdir', ['-p', samples, work]);
  run('python3', ['-I', '-c', PY_SAMPLES, samples]);
  const binary = path.join(dir, 'zip-test');
  run('swiftc', [
    '-O',
    `${root}/ios/ZipCodec.swift`,
    `${root}/tests/main.swift`,
    '-lz',
    '-o',
    binary,
  ]);
  run(binary, [work, samples, ...process.argv.slice(2)]);
  const kotlin = kotlinToolchain();
  if (kotlin) {
    // Android 的 Kotlin 实现：同一套检查，写出的包同样交给 unzip 和 python。
    const classes = path.join(dir, 'kt-classes');
    const kwork = path.join(dir, 'kt-work');
    run(kotlin.java, [
      '-cp',
      kotlin.compilerClasspath,
      'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
      '-no-stdlib',
      '-no-reflect',
      '-cp',
      kotlin.stdlib,
      '-d',
      classes,
      `${root}/android/src/main/java/expo/modules/morpharchive/ZipCodec.kt`,
      `${root}/tests/ZipTest.kt`,
    ]);
    run(kotlin.java, [
      '-cp',
      `${classes}${path.delimiter}${kotlin.stdlib}`,
      'expo.modules.morpharchive.ZipTestKt',
      kwork,
      samples,
      ...process.argv.slice(2),
    ]);
    for (const n of ['plain.zip', 'zip64.zip', 'many.zip'])
      run('unzip', ['-tq', path.join(kwork, n)]);
    run('python3', [
      '-I',
      '-c',
      PY_VERIFY,
      path.join(kwork, 'plain.zip'),
      path.join(kwork, 'zip64.zip'),
    ]);
  } else {
    console.log('Kotlin part skipped: no JDK 17 and Kotlin compiler found under ~/.gradle');
  }
  const written = ['plain.zip', 'zip64.zip', 'many.zip'].map((n) => path.join(work, n));
  if (existsSync(path.join(work, 'big.zip'))) written.push(path.join(work, 'big.zip'));
  for (const file of written) run('unzip', ['-tq', file]);
  run('python3', ['-I', '-c', PY_VERIFY, ...written.slice(0, 2)]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
