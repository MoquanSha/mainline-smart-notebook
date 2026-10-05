const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require("electron");
const { showOrCreateMainWindow } = require("./window-recovery.cjs");
const { randomBytes } = require("node:crypto");
const { createServer } = require("node:net");
const QRCode = require("qrcode");
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawn } = require("node:child_process");
const cloudSync = require("./cloud-sync.cjs");
const { createSyncRunner, createRemoteSyncLifecycle } = require("./sync-scheduler.cjs");
const { HomeTunnelClient } = require("./home-tunnel-client.cjs");
const { keepOrCreateHomeToken } = require("./home-credentials.cjs");
const { createProfileManager } = require("./profile-manager.cjs");
const { identity, getBuild, assertBuildReady, assertRuntimeIdentity, samePath } = require('./runtime-identity.cjs');

const MULTI_USER_APP_NAME = identity.productName;
const MULTI_USER_APP_ID = identity.appId;
const MULTI_USER_DATA_ROOT = resolve(
  process.env.MAINLINE_RELIABILITY_DATA_ROOT
    || process.env.MAINLINE_MULTI_USER_DATA_ROOT
    || join(app.getPath("appData"), identity.dataFolder),
);
app.setName(MULTI_USER_APP_NAME);
app.setPath("userData", MULTI_USER_DATA_ROOT);

const isPackaged = app.isPackaged;
const appRoot = isPackaged ? app.getAppPath() : resolve(__dirname, "..");
const runtimeBuild = getBuild(appRoot);
let expectedRuntime = null;
const profileManager = createProfileManager(app.getPath("userData"));
let activeProfile = null;
let appDataDirectory = "";
const iconPath = join(appRoot, "public", "favicon.png");
// CloudBase is used only as a manual, compact transport between desktop and mini program.
const CLOUD_SYNC_ENABLED = true;
let mainWindow;
let accountWindow;
let notebookServer;
let serverUrl;
let homeServerConfig;
let homeTunnelClient;
let notebookServerPort = identity.backendPort;
let notebookServerRestartTimer;
let notebookServerRestartAttempts = 0;
let notebookServerRestartEnabled = false;
let applicationIsQuitting = false;
let cloudRemoteLifecycle = null;
let cloudScopeEpoch = 0;
let cloudScopeStopping = false;
let cloudRemoteErrors = { watch: null, receive: null };
const cloudSyncRunner = createSyncRunner((scope, options) => cloudSync.sync(scope.userData, scope.serverUrl, options));
let pendingDesktopLogin = null;

function activeProfileDirectory() {
  if (!activeProfile?.rootDir) throw new Error("请先登录微信账号");
  return activeProfile.rootDir;
}

function isLocalOnlyMode(userData) {
  return !CLOUD_SYNC_ENABLED || existsSync(join(userData, "cloud-sync.local-only"));
}

async function runCloudSync(userData, options = {}) {
  if (isLocalOnlyMode(userData)) return { connected: false, disabled: true, localOnly: true };
  if (!serverUrl) return { connected: false, unavailable: true };
  if (cloudScopeStopping || applicationIsQuitting || activeProfile?.rootDir !== userData) throw Object.assign(new Error("账号已切换，本轮同步已停止"), { code: "SYNC_SCOPE_CHANGED", retryable: false });
  const scope = { key: `${cloudScopeEpoch}:${userData}:${serverUrl}`, userData, serverUrl };
  try {
    const result = await cloudSyncRunner.run(scope, options);
    if (result.receivePending || result.uploadPending && !result.conflicts) cloudRemoteLifecycle?.request(50);
    return result;
  } catch (error) {
    // Keep a local diagnostic without exposing credentials so partial syncs can be repaired.
    try {
      appendFileSync(
        join(userData, "cloud-sync-errors.log"),
        `${new Date().toISOString()} ${String(error?.code || "SYNC_ERROR")} ${String(error?.message || error || "unknown").slice(0, 500)}\n`,
        "utf8",
      );
    } catch {}
    if (!options.suppressErrors) throw error;
    return { connected: false, error: String(error?.message || error || "sync failed"), code: error?.code, retryable: error?.retryable };
  }
}

function notifyRemoteCloudApplied(result) {
  if (!result?.connected || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("mainline-cloud:remote-applied", {
    pulled: Number(result.pulled || 0),
    pushed: Number(result.pushed || 0),
    conflicts: Number(result.conflicts || 0),
    lastSyncAt: result.lastSyncAt || new Date().toISOString(),
    receivePending: Boolean(result.receivePending),
    uploadPending: Number(result.uploadPending || 0),
    receiveProtocol: result.receiveProtocol,
  });
}

function stopRemoteCloudWatch() {
  cloudRemoteLifecycle?.stop();
  cloudRemoteLifecycle = null;
}

function startRemoteCloudWatch(userData) {
  if (applicationIsQuitting || cloudScopeStopping || isLocalOnlyMode(userData) || cloudRemoteLifecycle) return;
  const epoch = cloudScopeEpoch;
  cloudRemoteErrors = { watch: null, receive: null };
  cloudRemoteLifecycle = createRemoteSyncLifecycle({
    isActive: () => !applicationIsQuitting && !cloudScopeStopping && epoch === cloudScopeEpoch && activeProfile?.rootDir === userData && !isLocalOnlyMode(userData),
    watch: (changed, signal, ready) => cloudSync.watchRemote(userData, changed, signal, () => {
      if (epoch === cloudScopeEpoch && !signal.aborted) cloudRemoteErrors.watch = null;
      ready();
    }),
    sync: () => runCloudSync(userData),
    onResult: (result) => { cloudRemoteErrors.receive = null; notifyRemoteCloudApplied(result); },
    onError: (error, phase) => { cloudRemoteErrors[phase] = { code: error?.code || "SYNC_CONNECTION_ERROR", message: String(error?.message || error).slice(0, 500) }; },
  });
  cloudRemoteLifecycle.start();
}

function probePort(port) {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : 0;
      probe.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function findAvailablePort() {
  try { return await probePort(identity.backendPort); }
  catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    return probePort(0);
  }
}

function homeServerConfigPath() {
  return join(activeProfileDirectory(), "home-server.json");
}

function decryptHomeToken(value) {
  if (!value || !safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  } catch {
    return "";
  }
}

function ensureHomeServerConfig() {
  const configPath = homeServerConfigPath();
  let current = {};
  if (existsSync(configPath)) {
    try { current = JSON.parse(readFileSync(configPath, "utf8")); } catch {}
  }
  const previousToken = decryptHomeToken(current.tokenEncrypted) || String(current.token || "").trim();
  // randomBytes(32).toString("base64url") is 43 characters. Treat that full
  // 256-bit value as valid so restarting the desktop app does not silently
  // rotate the phone credential and disconnect an already paired device.
  const token = keepOrCreateHomeToken(previousToken, () => randomBytes(32).toString("base64url"));
  const publicUrl = String(current.publicUrl || "").trim().replace(/\/$/, "");
  const stored = {
    version: 2,
    enabled: true,
    publicUrl,
    updatedAt: new Date().toISOString(),
  };
  if (safeStorage.isEncryptionAvailable()) {
    stored.tokenEncrypted = safeStorage.encryptString(token).toString("base64");
  } else {
    stored.token = token;
  }
  writeFileSync(configPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  return { token, publicUrl, configPath };
}

function saveHomePublicUrl(value) {
  const publicUrl = String(value || "").trim().replace(/\/$/, "");
  if (publicUrl) {
    const parsed = new URL(publicUrl);
    if (parsed.protocol !== "https:") throw new Error("家庭同步地址必须使用 HTTPS");
  }
  homeServerConfig = { ...ensureHomeServerConfig(), publicUrl };
  const configPath = homeServerConfigPath();
  const stored = JSON.parse(readFileSync(configPath, "utf8"));
  stored.publicUrl = publicUrl;
  stored.updatedAt = new Date().toISOString();
  writeFileSync(configPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  return homeServerConfig;
}

function homeTunnelConfigPath() {
  return join(activeProfileDirectory(), "home-tunnel.json");
}

function decryptTunnelToken(value) {
  if (!value || !safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  } catch {
    return "";
  }
}

function readHomeTunnelConfig() {
  const configPath = homeTunnelConfigPath();
  if (!existsSync(configPath)) return null;
  try {
    const current = JSON.parse(readFileSync(configPath, "utf8"));
    const tunnelToken = decryptTunnelToken(current.tunnelTokenEncrypted);
    if (!current.relayBaseUrl || !current.homeId || !tunnelToken) return null;
    return {
      relayBaseUrl: String(current.relayBaseUrl).trim().replace(/\/$/, ""),
      homeId: String(current.homeId).trim(),
      tunnelToken,
      configuredAt: current.configuredAt,
    };
  } catch {
    return null;
  }
}

function validateHomeTunnelConfig(input, previous = {}) {
  const relayBaseUrl = String(input?.relayBaseUrl || previous?.relayBaseUrl || "").trim().replace(/\/$/, "");
  const homeId = String(input?.homeId || previous?.homeId || "").trim();
  const tunnelToken = String(input?.tunnelToken || previous?.tunnelToken || "").trim();
  const url = new URL(relayBaseUrl);
  const localTest = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(localTest && url.protocol === "http:")) {
    throw new Error("固定中继地址必须使用 HTTPS");
  }
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(homeId)) throw new Error("家庭服务器 ID 格式不正确");
  if (tunnelToken.length < 32) throw new Error("隧道令牌至少需要 32 个字符");
  return { relayBaseUrl, homeId, tunnelToken, configuredAt: new Date().toISOString() };
}

function saveHomeTunnelConfig(config) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Windows 安全存储当前不可用，未保存隧道令牌");
  }
  const stored = {
    relayBaseUrl: config.relayBaseUrl,
    homeId: config.homeId,
    tunnelTokenEncrypted: safeStorage.encryptString(config.tunnelToken).toString("base64"),
    configuredAt: config.configuredAt,
  };
  writeFileSync(homeTunnelConfigPath(), `${JSON.stringify(stored, null, 2)}\n`, "utf8");
}

function ensureHomeTunnelClient() {
  if (!homeTunnelClient) homeTunnelClient = new HomeTunnelClient({ localBaseUrl: serverUrl || `http://127.0.0.1:${identity.backendPort}` });
  homeTunnelClient.localBaseUrl = serverUrl || `http://127.0.0.1:${identity.backendPort}`;
  return homeTunnelClient;
}

function publicTunnelStatus() {
  const status = ensureHomeTunnelClient().status();
  return { ...status, tokenStored: Boolean(readHomeTunnelConfig()) };
}

function startSavedHomeTunnel() {
  const config = readHomeTunnelConfig();
  if (!config) return publicTunnelStatus();
  ensureHomeTunnelClient().start(config);
  return publicTunnelStatus();
}

function publicHomeServerStatus() {
  const config = homeServerConfig || ensureHomeServerConfig();
  const tunnel = publicTunnelStatus();
  return {
    enabled: true,
    port: serverUrl ? Number(new URL(serverUrl).port) : identity.backendPort,
    localUrl: serverUrl || `http://127.0.0.1:${identity.backendPort}`,
    publicUrl: tunnel.publicEndpoint || config.publicUrl,
    token: config.token,
    configPath: config.configPath,
    tunnel,
  };
}

function waitForHealth(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolveHealth, reject) => {
    const poll = async () => {
      try {
        const response = await fetch(`${url}/api/health`);
        if (response.ok) {
          assertRuntimeIdentity(await response.json(), expectedRuntime);
          return resolveHealth();
        }
      } catch (error) {
        if (error.code === 'BUILD_INSTANCE_MISMATCH') return reject(error);
        // The local server is still starting.
      }

      if (Date.now() >= deadline) {
        return reject(new Error("主线笔记的本地服务未能在 15 秒内启动。"));
      }
      setTimeout(poll, 250);
    };
    poll();
  });
}

function appendServerRuntimeLog(message) {
  try {
    appendFileSync(
      join(activeProfile?.rootDir || app.getPath("userData"), "server-runtime.log"),
      `${new Date().toISOString()} ${String(message || "").slice(0, 4000)}\n`,
      "utf8",
    );
  } catch {}
}

function scheduleNotebookServerRestart() {
  if (applicationIsQuitting || !notebookServerRestartEnabled || notebookServerRestartTimer) return;
  const delay = Math.min(30_000, 800 * (2 ** Math.min(5, notebookServerRestartAttempts)));
  notebookServerRestartTimer = setTimeout(async () => {
    notebookServerRestartTimer = null;
    notebookServerRestartAttempts += 1;
    try {
      await launchNotebookServer(notebookServerPort);
      await waitForHealth(serverUrl, 20_000);
      notebookServerRestartAttempts = 0;
      appendServerRuntimeLog(`server recovered on ${serverUrl}`);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    } catch (error) {
      appendServerRuntimeLog(`server restart failed: ${error?.stack || error}`);
      if (notebookServer && !notebookServer.killed) notebookServer.kill();
      scheduleNotebookServerRestart();
    }
  }, delay);
}

async function launchNotebookServer(port) {
  serverUrl = `http://127.0.0.1:${port}`;
  const serverScript = join(appRoot, "server.mjs");
  homeServerConfig = ensureHomeServerConfig();
  const instanceId = randomBytes(24).toString('hex');

  const child = spawn(process.execPath, [serverScript], {
    cwd: appRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --max-old-space-size=768`.trim(),
      SMART_NOTEBOOK_PORT: String(port),
      SMART_NOTEBOOK_INSTANCE_ID: instanceId,
      SMART_NOTEBOOK_CLOUD_MODE: "false",
      SMART_NOTEBOOK_HOST: "127.0.0.1",
      SMART_NOTEBOOK_DATA_DIR: appDataDirectory,
      SMART_NOTEBOOK_USER_DATA: activeProfileDirectory(),
      SMART_NOTEBOOK_HOME_TOKEN: homeServerConfig.token,
      SMART_NOTEBOOK_HOME_OWNER: JSON.stringify({ userId: activeProfile.userId, workspaceId: activeProfile.workspaceId }),
      SMART_NOTEBOOK_EMPTY_SEED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  notebookServer = child;
  expectedRuntime = { build: runtimeBuild, pid: child.pid, instanceId, appRoot, dataPath: join(appDataDirectory, 'notebook.json') };
  child.stdout?.on("data", (chunk) => appendServerRuntimeLog(`stdout: ${chunk.toString("utf8").trim()}`));
  child.stderr?.on("data", (chunk) => appendServerRuntimeLog(`stderr: ${chunk.toString("utf8").trim()}`));

  child.once("error", (error) => {
    appendServerRuntimeLog(`spawn error: ${error?.stack || error}`);
    console.error("Unable to start the notebook server", error);
  });
  child.once("exit", (code, signal) => {
    if (notebookServer === child) notebookServer = null;
    appendServerRuntimeLog(`server exited code=${code ?? ""} signal=${signal ?? ""}`);
    scheduleNotebookServerRestart();
  });
}

async function startNotebookServer() {
  const port = await findAvailablePort();
  notebookServerPort = port;
  await launchNotebookServer(port);
  await waitForHealth(serverUrl);
  notebookServerRestartEnabled = true;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: MULTI_USER_APP_NAME,
    icon: existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: "#f8f7f2",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.once("closed", () => {
    mainWindow = null;
  });
  mainWindow.loadURL(serverUrl);
  return mainWindow;
}

function publicProfile(profile) {
  if (!profile) return null;
  return {
    profileKey: profile.profileKey,
    userId: profile.userId,
    workspaceId: profile.workspaceId,
    displayName: profile.displayName,
    deviceId: profile.deviceId || "",
    lastUsedAt: profile.lastUsedAt || "",
  };
}

async function profilesForRenderer() {
  const profiles = await profileManager.listProfiles();
  return Promise.all(profiles.map(async (profile) => {
    const stored = await profileManager.getProfile(profile.profileKey);
    const status = stored ? await cloudSync.status(stored.rootDir).catch(() => ({ connected: false })) : { connected: false };
    return { ...publicProfile(profile), active: profile.active, connected: status.connected === true };
  }));
}

function createAccountWindow() {
  if (accountWindow && !accountWindow.isDestroyed()) {
    accountWindow.show();
    accountWindow.focus();
    return accountWindow;
  }
  accountWindow = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 760,
    minHeight: 620,
    show: false,
    title: `${MULTI_USER_APP_NAME} · 登录`,
    icon: existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: "#f4f5f8",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "account-preload.cjs"),
    },
  });
  accountWindow.setMenuBarVisibility(false);
  accountWindow.once("ready-to-show", () => accountWindow.show());
  accountWindow.once("closed", () => {
    const abandoned = pendingDesktopLogin;
    pendingDesktopLogin = null;
    if (abandoned) void cloudSync.cancelLogin(abandoned).catch(() => {});
    accountWindow = null;
  });
  accountWindow.loadFile(join(__dirname, "account.html"));
  return accountWindow;
}

async function stopNotebookServer() {
  stopRemoteCloudWatch();
  cloudScopeStopping = true;
  cloudScopeEpoch++;
  await cloudSyncRunner.cancel();
  cloudRemoteErrors = { watch: null, receive: null };
  notebookServerRestartEnabled = false;
  if (notebookServerRestartTimer) clearTimeout(notebookServerRestartTimer);
  notebookServerRestartTimer = null;
  homeTunnelClient?.stop(false);
  homeTunnelClient = null;
  homeServerConfig = null;
  const child = notebookServer;
  notebookServer = null;
  serverUrl = "";
  if (child && !child.killed) {
    await new Promise((resolveStop) => {
      const timeout = setTimeout(resolveStop, 2500);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolveStop();
      });
      child.kill();
    });
  }
  cloudScopeStopping = false;
}

async function activateProfile(profileKey) {
  if (activeProfile?.profileKey === profileKey && serverUrl) {
    mainWindow = showOrCreateMainWindow({ mainWindow, serverUrl, createWindow });
    return publicProfile(activeProfile);
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  await stopNotebookServer();
  activeProfile = await profileManager.setActive(profileKey);
  appDataDirectory = activeProfile.dataDir;
  await startNotebookServer();
  startSavedHomeTunnel();
  const userData = activeProfileDirectory();
  if (!isLocalOnlyMode(userData)) {
    // Always attempt one startup sync. A transient status/decryption/network
    // failure must not silently skip the first repairable sync window.
    const result = await runCloudSync(userData, { suppressErrors: true });
    if (result.connected) startRemoteCloudWatch(userData);
  }
  createWindow();
  if (accountWindow && !accountWindow.isDestroyed()) accountWindow.close();
  return publicProfile(activeProfile);
}

async function leaveActiveProfile({ disconnect = false } = {}) {
  const current = activeProfile;
  // Keep the account window alive before closing the notebook window. This
  // prevents Windows/Electron and automation hosts from treating a deliberate
  // account switch as an application exit.
  createAccountWindow();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  await stopNotebookServer();
  if (disconnect && current?.rootDir) await cloudSync.disconnect(current.rootDir);
  await profileManager.clearActive();
  activeProfile = null;
  appDataDirectory = "";
  return { active: false, disconnected: disconnect };
}

function registerIpcHandlers() {
  ipcMain.handle("mainline-profile:list", () => profilesForRenderer());
  ipcMain.handle("mainline-profile:current", () => publicProfile(activeProfile));
  ipcMain.handle("mainline-profile:activate", (_event, profileKey) => activateProfile(String(profileKey || "")));
  ipcMain.handle("mainline-profile:switch", () => leaveActiveProfile({ disconnect: false }));
  ipcMain.handle("mainline-profile:logout", () => leaveActiveProfile({ disconnect: true }));
  ipcMain.handle("mainline-profile:login-start", async (_event, options) => {
    const previous = pendingDesktopLogin;
    pendingDesktopLogin = null;
    if (previous) await cloudSync.cancelLogin(previous).catch(() => {});
    const session = await cloudSync.startLogin(options);
    pendingDesktopLogin = session;
    const qrDataUrl = session.qrDataUrl || await QRCode.toDataURL(session.loginUrl, {
      width: 360,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#1f2533", light: "#ffffff" },
    });
    return {
      sessionId: session.sessionId,
      qrDataUrl,
      expiresAt: session.expiresAt,
      deviceName: session.deviceName,
    };
  });
  ipcMain.handle("mainline-profile:login-complete", async (_event, sessionId) => {
    const session = pendingDesktopLogin;
    if (!session || session.sessionId !== String(sessionId || "")) {
      throw new Error("扫码登录会话已失效，请重新生成二维码");
    }
    let pairing;
    try {
      pairing = await cloudSync.exchangeLogin(session);
    } catch (error) {
      if (error?.code === "LOGIN_WAITING") return { status: "waiting" };
      if (["LOGIN_EXPIRED", "LOGIN_USED", "NOT_FOUND"].includes(error?.code)) pendingDesktopLogin = null;
      throw error;
    }
    pendingDesktopLogin = null;
    const profile = await profileManager.registerProfile({
      userId: pairing.userId,
      workspaceId: pairing.workspaceId,
      deviceId: pairing.deviceId,
      displayName: pairing.displayName || "微信用户",
    });
    await cloudSync.savePairing(profile.rootDir, pairing);
    await activateProfile(profile.profileKey);
    return { status: "connected", profile: publicProfile(profile) };
  });
  ipcMain.handle("mainline-profile:login-cancel", async (_event, sessionId) => {
    const session = pendingDesktopLogin;
    if (!session || session.sessionId !== String(sessionId || "")) return { cancelled: false };
    pendingDesktopLogin = null;
    return cloudSync.cancelLogin(session).catch(() => ({ cancelled: false }));
  });
  ipcMain.handle("mainline-profile:create-test", async (_event, suffix) => {
    if (app.isPackaged || process.env.MAINLINE_ALLOW_TEST_PROFILES !== "true") {
      throw new Error("测试账号功能未启用");
    }
    const safe = String(suffix || "A").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "A";
    const profile = await profileManager.registerProfile({
      userId: `local_test_user_${safe}`,
      workspaceId: `local_test_workspace_${safe}`,
      displayName: `本地测试账号 ${safe}`,
    });
    await activateProfile(profile.profileKey);
    return publicProfile(profile);
  });

  ipcMain.handle("mainline-cloud:pair", async (_event, options) => {
    const userData = activeProfileDirectory();
    if (isLocalOnlyMode(userData)) {
      throw new Error("当前已锁定为仅本地模式，请先解除本地模式后再连接云端");
    }
    const pairing = await cloudSync.exchangePair(options);
    if (pairing.userId !== activeProfile.userId || pairing.workspaceId !== activeProfile.workspaceId) {
      throw new Error("扫码身份与当前电脑资料不一致，请先切换账号");
    }
    const result = await cloudSync.savePairing(userData, pairing);
    await runCloudSync(userData);
    startRemoteCloudWatch(userData);
    return result;
  });
  ipcMain.handle("mainline-cloud:sync", () => {
    const userData = activeProfileDirectory();
    return isLocalOnlyMode(userData)
      ? { connected: false, disabled: true, localOnly: true }
      : runCloudSync(userData);
  });
  ipcMain.handle("mainline-cloud:status", async () => {
    const userData = activeProfileDirectory();
    return isLocalOnlyMode(userData)
      ? { connected: false, disabled: true, localOnly: true }
      : { ...await cloudSync.status(userData), receiveError: cloudRemoteErrors.receive || cloudRemoteErrors.watch };
  });
  ipcMain.handle("mainline-cloud:disconnect", async () => {
    const userData = activeProfileDirectory();
    if (isLocalOnlyMode(userData)) return { connected: false, disabled: true, localOnly: true };
    stopRemoteCloudWatch();
    cloudScopeStopping = true;
    cloudScopeEpoch++;
    try {
      await cloudSyncRunner.cancel();
      return await cloudSync.disconnect(userData);
    } finally { cloudScopeStopping = false; }
  });
  ipcMain.handle("mainline-home:status", () => publicHomeServerStatus());
  ipcMain.handle("mainline-home:set-public-url", (_event, publicUrl) => {
    saveHomePublicUrl(publicUrl);
    return publicHomeServerStatus();
  });
  ipcMain.handle("mainline-home:configure-tunnel", (_event, input) => {
    const config = validateHomeTunnelConfig(input, readHomeTunnelConfig() || {});
    saveHomeTunnelConfig(config);
    ensureHomeTunnelClient().start(config);
    return publicHomeServerStatus();
  });
  ipcMain.handle("mainline-home:restart-tunnel", () => {
    startSavedHomeTunnel();
    return publicHomeServerStatus();
  });
  ipcMain.handle("mainline-home:disconnect-tunnel", () => {
    ensureHomeTunnelClient().stop(false);
    return publicHomeServerStatus();
  });
}

const instanceIntent = { appRoot, sourceId: runtimeBuild.sourceId, quit: process.argv.includes('--quit-reliability-instance') };
const hasSingleInstanceLock = app.requestSingleInstanceLock(instanceIntent);
if (!hasSingleInstanceLock || instanceIntent.quit) {
  app.quit();
} else {
  app.on("second-instance", (_event, _argv, _directory, incoming) => {
    if (!samePath(incoming?.appRoot, appRoot) || incoming?.sourceId !== runtimeBuild.sourceId) {
      dialog.showErrorBox('另一个测试版本正在运行', '请先退出当前测试版，再打开新的测试副本。');
      return;
    }
    if (incoming.quit) { app.quit(); return; }
    if (activeProfile && serverUrl) {
      mainWindow = showOrCreateMainWindow({ mainWindow, serverUrl, createWindow });
    } else {
      createAccountWindow();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId(MULTI_USER_APP_ID);
    try {
      assertBuildReady(appRoot, isPackaged);
      registerIpcHandlers();
      const storedProfile = await profileManager.getActive();
      if (storedProfile) await activateProfile(storedProfile.profileKey);
      else createAccountWindow();
    } catch (error) {
      dialog.showErrorBox(`${MULTI_USER_APP_NAME}无法启动`, error.message || String(error));
      app.quit();
    }
  });

  app.on("activate", () => {
    if (activeProfile && serverUrl) {
      mainWindow = showOrCreateMainWindow({ mainWindow, serverUrl, createWindow });
    } else {
      createAccountWindow();
    }
  });

  app.on("before-quit", () => {
    applicationIsQuitting = true;
    stopRemoteCloudWatch();
    void cloudSyncRunner.cancel();
    notebookServerRestartEnabled = false;
    if (notebookServerRestartTimer) clearTimeout(notebookServerRestartTimer);
    homeTunnelClient?.stop(false);
    if (notebookServer && !notebookServer.killed) notebookServer.kill();
  });
}
