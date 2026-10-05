const { createHash } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { resolve, join, relative } = require('node:path');
const identity = require('../shared/build-identity.json');

// Only source directories shipped with the app participate. Never hash data,
// credentials, dependencies or mutable files under the user's profile.
function sourceHash(root, entries) {
  const files = [];
  function visit(name) {
    const path = join(root, name);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(name, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  for (const name of entries) {
    if (name.endsWith('/')) visit(name);
    else files.push(name);
  }
  const hash = createHash('sha256');
  // TypeScript declaration files are source-only and electron-builder omits
  // them from the runtime package. Exclude them so source and packaged trees
  // produce the same release fingerprint.
  for (const name of files.filter((name) => !name.endsWith('.d.ts')).sort()) {
    hash.update(relative(root, join(root, name)).replace(/\\/g, '/'));
    hash.update('\0');
    // electron-builder keeps the production manifest but removes build-time
    // fields such as `scripts`, `devDependencies`, and `build`. Hash only the
    // fields present in both source and packaged manifests so the same release
    // has one sourceId before and after packaging.
    if (name === 'package.json') {
      const pkg = JSON.parse(readFileSync(join(root, name), 'utf8'));
      const stable = Object.fromEntries(Object.entries(pkg)
        .filter(([key]) => !['scripts', 'devDependencies', 'build'].includes(key))
        .sort(([a], [b]) => a.localeCompare(b)));
      hash.update(JSON.stringify(stable));
    } else {
      hash.update(readFileSync(join(root, name)));
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

function getBuild(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const hasBuildConfig = pkg.build && typeof pkg.build === 'object';
  if (pkg.version !== identity.version || (hasBuildConfig
    && (pkg.build.appId !== identity.appId || pkg.build.productName !== identity.productName))) {
    throw new Error('测试版名称、版本和构建配置不一致，请重新构建。');
  }
  return { ...identity, sourceId: sourceHash(root, [
    'package.json', 'server.mjs', 'home-sync.mjs', 'home-history.mjs', 'local-recovery.mjs',
    'relay/home-forwarding.cjs', 'electron/', 'shared/', 'ai/', 'hooks/',
  ]) };
}

function frontendSourceId(root) {
  return sourceHash(root, ['src/', 'index.html', 'vite.config.ts']);
}

function assertBuildReady(root, packaged = false) {
  let built;
  try { built = JSON.parse(readFileSync(join(root, 'dist', 'build-identity.json'), 'utf8')); }
  catch { throw new Error('测试版页面尚未构建，请先运行测试版构建命令。'); }
  const expected = getBuild(root);
  if (built.sourceId !== expected.sourceId || built.releaseSet !== expected.releaseSet || built.version !== expected.version
    || (!packaged && built.frontendSourceId !== frontendSourceId(root))) {
    throw new Error('页面与当前测试版源码不一致，请重新构建后再打开。');
  }
  // A manifest on its own is insufficient if files were deleted or overwritten.
  if (!built.assets || !Object.keys(built.assets).length) throw new Error('页面构建清单不完整，请重新构建。');
  for (const [name, digest] of Object.entries(built.assets)) {
    if (name.includes('..') || /[\\:]/.test(name) || name.startsWith('/')) throw new Error('页面构建清单包含无效路径。');
    if (!require('node:fs').existsSync(join(root, 'dist', name))) throw new Error('页面构建文件不完整，请重新构建后再打开。');
  }
  return expected;
}

function samePath(left, right) {
  if (!left || !right) return false;
  const normalize = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

function assertRuntimeIdentity(health, expected) {
  if (!health?.ok || health.mode !== 'local' || health.build?.sourceId !== expected.build.sourceId
    || health.build?.releaseSet !== expected.build.releaseSet || health.build?.version !== expected.build.version
    || health.runtime?.instanceId !== expected.instanceId || health.runtime?.pid !== expected.pid
    || !samePath(health.runtime?.appRoot, expected.appRoot) || !samePath(health.runtime?.dataPath, expected.dataPath)) {
    throw Object.assign(new Error('本地服务的版本、数据目录或进程身份不匹配，已停止打开。'), { code: 'BUILD_INSTANCE_MISMATCH' });
  }
}

module.exports = { identity, getBuild, frontendSourceId, assertBuildReady, assertRuntimeIdentity, samePath };
