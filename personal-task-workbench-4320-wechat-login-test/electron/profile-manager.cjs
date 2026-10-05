const { createHash } = require("node:crypto");
const { existsSync } = require("node:fs");
const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const { join, resolve, sep } = require("node:path");

const REGISTRY_VERSION = 1;

function cleanId(value, label) {
  const result = String(value || "").trim();
  if (!result || result.length > 160 || /[\u0000-\u001f]/.test(result)) {
    throw new Error(`${label}无效`);
  }
  return result;
}

function cleanLabel(value, fallback = "微信用户") {
  return String(value || fallback).replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60) || fallback;
}

function deriveProfileKey({ userId, workspaceId }) {
  const safeUserId = cleanId(userId, "用户标识");
  const safeWorkspaceId = cleanId(workspaceId, "工作区标识");
  return createHash("sha256")
    .update(`${safeUserId}\n${safeWorkspaceId}`)
    .digest("hex")
    .slice(0, 24);
}

function createEmptyRegistry() {
  return { version: REGISTRY_VERSION, activeProfileKey: "", profiles: [] };
}

function normalizeRegistry(value) {
  const registry = value && typeof value === "object" ? value : createEmptyRegistry();
  const profiles = Array.isArray(registry.profiles) ? registry.profiles : [];
  const normalized = [];
  const seen = new Set();
  for (const profile of profiles) {
    try {
      const userId = cleanId(profile.userId, "用户标识");
      const workspaceId = cleanId(profile.workspaceId, "工作区标识");
      const profileKey = deriveProfileKey({ userId, workspaceId });
      if (seen.has(profileKey)) continue;
      seen.add(profileKey);
      normalized.push({
        profileKey,
        userId,
        workspaceId,
        displayName: cleanLabel(profile.displayName),
        deviceId: String(profile.deviceId || "").trim().slice(0, 160),
        createdAt: String(profile.createdAt || ""),
        lastUsedAt: String(profile.lastUsedAt || ""),
      });
    } catch {}
  }
  const activeProfileKey = normalized.some((item) => item.profileKey === registry.activeProfileKey)
    ? registry.activeProfileKey
    : "";
  return { version: REGISTRY_VERSION, activeProfileKey, profiles: normalized };
}

function createProfileManager(userDataRoot, options = {}) {
  const root = resolve(userDataRoot);
  const profilesRoot = join(root, "profiles");
  const registryPath = join(root, "profiles.json");
  const clock = typeof options.now === "function" ? options.now : () => new Date().toISOString();

  function assertProfilePath(profileKey) {
    const path = resolve(profilesRoot, profileKey);
    if (!path.startsWith(`${resolve(profilesRoot)}${sep}`)) throw new Error("用户资料目录越界");
    return path;
  }

  function withPaths(profile) {
    if (!profile) return null;
    const rootDir = assertProfilePath(profile.profileKey);
    return {
      ...profile,
      rootDir,
      dataDir: join(rootDir, "data"),
      attachmentsDir: join(rootDir, "attachments"),
      queueDir: join(rootDir, "queue"),
      backupDir: join(rootDir, "backup"),
    };
  }

  async function ensureRoot() {
    await mkdir(profilesRoot, { recursive: true });
  }

  async function readRegistry() {
    await ensureRoot();
    if (!existsSync(registryPath)) return createEmptyRegistry();
    try {
      return normalizeRegistry(JSON.parse(await readFile(registryPath, "utf8")));
    } catch {
      return createEmptyRegistry();
    }
  }

  async function writeRegistry(registry) {
    await ensureRoot();
    const normalized = normalizeRegistry(registry);
    const temporary = `${registryPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await rename(temporary, registryPath);
    return normalized;
  }

  async function ensureProfileDirectories(profile) {
    const resolved = withPaths(profile);
    await Promise.all([
      mkdir(resolved.dataDir, { recursive: true }),
      mkdir(resolved.attachmentsDir, { recursive: true }),
      mkdir(resolved.queueDir, { recursive: true }),
      mkdir(resolved.backupDir, { recursive: true }),
    ]);
    return resolved;
  }

  async function registerProfile(input) {
    const userId = cleanId(input?.userId, "用户标识");
    const workspaceId = cleanId(input?.workspaceId, "工作区标识");
    const profileKey = deriveProfileKey({ userId, workspaceId });
    const registry = await readRegistry();
    const existing = registry.profiles.find((item) => item.profileKey === profileKey);
    const timestamp = clock();
    const profile = {
      profileKey,
      userId,
      workspaceId,
      displayName: cleanLabel(input?.displayName, existing?.displayName || "微信用户"),
      deviceId: String(input?.deviceId || existing?.deviceId || "").trim().slice(0, 160),
      createdAt: existing?.createdAt || timestamp,
      lastUsedAt: timestamp,
    };
    registry.profiles = [...registry.profiles.filter((item) => item.profileKey !== profileKey), profile];
    await writeRegistry(registry);
    return ensureProfileDirectories(profile);
  }

  async function listProfiles() {
    const registry = await readRegistry();
    return registry.profiles
      .map((profile) => ({ ...profile, active: profile.profileKey === registry.activeProfileKey }))
      .sort((left, right) => String(right.lastUsedAt).localeCompare(String(left.lastUsedAt)));
  }

  async function getProfile(profileKey) {
    const registry = await readRegistry();
    const profile = registry.profiles.find((item) => item.profileKey === String(profileKey || ""));
    return profile ? ensureProfileDirectories(profile) : null;
  }

  async function setActive(profileKey) {
    const registry = await readRegistry();
    const index = registry.profiles.findIndex((item) => item.profileKey === String(profileKey || ""));
    if (index < 0) throw new Error("账号资料不存在");
    const timestamp = clock();
    registry.activeProfileKey = registry.profiles[index].profileKey;
    registry.profiles[index] = { ...registry.profiles[index], lastUsedAt: timestamp };
    const stored = await writeRegistry(registry);
    return ensureProfileDirectories(stored.profiles.find((item) => item.profileKey === stored.activeProfileKey));
  }

  async function getActive() {
    const registry = await readRegistry();
    if (!registry.activeProfileKey) return null;
    const profile = registry.profiles.find((item) => item.profileKey === registry.activeProfileKey);
    return profile ? ensureProfileDirectories(profile) : null;
  }

  async function clearActive() {
    const registry = await readRegistry();
    registry.activeProfileKey = "";
    await writeRegistry(registry);
  }

  return {
    root,
    profilesRoot,
    registryPath,
    registerProfile,
    listProfiles,
    getProfile,
    setActive,
    getActive,
    clearActive,
  };
}

module.exports = { createProfileManager, deriveProfileKey };
