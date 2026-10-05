import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const desktop = path.join(root, "personal-task-workbench-4320-wechat-login-test");
const mini = path.join(root, "wechat-mini-program-0.10.37-login-copy-20260905");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("release identity is identical across desktop, mini-program, and cloud functions", () => {
  const build = read(path.join(desktop, "shared", "build-identity.json"));
  const pkg = read(path.join(desktop, "package.json"));
  const lock = read(path.join(desktop, "package-lock.json"));
  const backend = read(path.join(mini, "cloudfunctions", "release-identity.json"));
  const env = fs.readFileSync(path.join(mini, "miniprogram", "config", "env.js"), "utf8");

  assert.equal(pkg.version, build.version);
  assert.equal(lock.version, build.version);
  assert.equal(lock.packages[""].version, build.version);
  assert.match(env, new RegExp(`clientVersion: ['"]${build.miniVersion.replaceAll('.', '\\.') }['"]`));
  assert.equal(backend.releaseSet, build.releaseSet);
  assert.equal(backend.desktopVersion, build.version);
  assert.equal(backend.miniVersion, build.miniVersion);
});
