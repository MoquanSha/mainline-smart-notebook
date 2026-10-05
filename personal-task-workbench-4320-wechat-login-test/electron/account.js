const profileList = document.querySelector("#profileList");
const emptyProfiles = document.querySelector("#emptyProfiles");
const message = document.querySelector("#accountMessage");
const loginForm = document.querySelector("#loginForm");
const startLoginButton = document.querySelector("#startLoginButton");
const qrPanel = document.querySelector("#qrPanel");
const loginQr = document.querySelector("#loginQr");
const qrExpiry = document.querySelector("#qrExpiry");
const completeLoginButton = document.querySelector("#completeLoginButton");
const cancelLoginButton = document.querySelector("#cancelLoginButton");

let activeSessionId = "";
let autoCheckTimer = null;
let autoCheckCount = 0;
let checkingLogin = false;
const DEFAULT_ENDPOINT = "https://YOUR_CLOUDBASE_DOMAIN/desktop-sync";
const AUTO_CHECK_DELAYS_MS = [3000, 5000, 8000, 15000, 30000, 60000];

function showMessage(text, error = false) {
  message.textContent = text || "";
  message.classList.toggle("error", error);
}

function stopAutoChecks() {
  if (autoCheckTimer) clearInterval(autoCheckTimer);
  autoCheckTimer = null;
}

function profileRow(profile) {
  const row = document.createElement("div");
  row.className = "profile-item";
  const copy = document.createElement("div");
  copy.className = "profile-copy";
  const title = document.createElement("strong");
  title.textContent = profile.displayName || "微信用户";
  const status = document.createElement("small");
  status.className = `profile-status${profile.connected ? "" : " offline"}`;
  status.textContent = profile.connected ? "已保存安全登录信息" : "需要重新连接微信";
  copy.append(title, status);
  const open = document.createElement("button");
  open.className = "profile-open";
  open.type = "button";
  open.textContent = "进入";
  open.addEventListener("click", async () => {
    open.disabled = true;
    showMessage(`正在打开${title.textContent}…`);
    try { await window.mainlineAccounts.activate(profile.profileKey); }
    catch (error) {
      open.disabled = false;
      showMessage(error?.message || "账号没有打开", true);
    }
  });
  row.append(copy, open);
  return row;
}

async function refreshProfiles() {
  const profiles = await window.mainlineAccounts.list();
  profileList.replaceChildren(...profiles.map(profileRow));
  emptyProfiles.hidden = profiles.length > 0;
}

async function checkLogin({ manual = false } = {}) {
  if (!activeSessionId || checkingLogin) return;
  checkingLogin = true;
  completeLoginButton.disabled = true;
  if (manual) showMessage("正在领取手机确认结果…");
  try {
    const result = await window.mainlineAccounts.completeLogin(activeSessionId);
    if (result?.status === "waiting") {
      showMessage(manual ? "手机尚未确认，请在小程序中扫描二维码并允许登录" : "等待手机确认…");
      return;
    }
    if (result?.status === "connected") {
      stopAutoChecks();
      activeSessionId = "";
      showMessage("登录成功，正在打开你的独立笔记空间…");
    }
  } catch (error) {
    stopAutoChecks();
    showMessage(error?.message || "扫码登录没有完成", true);
  } finally {
    checkingLogin = false;
    completeLoginButton.disabled = false;
  }
}

function beginBoundedAutoChecks() {
  stopAutoChecks();
  autoCheckCount = 0;
  const startedAt = Date.now();
  const expiresAt = startedAt + 10 * 60 * 1000;
  const schedule = () => {
    if (!activeSessionId) return;
    if (Date.now() >= expiresAt) {
      stopAutoChecks();
      showMessage("二维码已过期，请重新生成");
      return;
    }
    const delay = AUTO_CHECK_DELAYS_MS[Math.min(autoCheckCount, AUTO_CHECK_DELAYS_MS.length - 1)];
    autoCheckTimer = setTimeout(async () => {
      if (!activeSessionId) return;
      autoCheckCount += 1;
      await checkLogin();
      if (activeSessionId) schedule();
    }, delay);
  };
  schedule();
}

document.querySelector("#refreshProfiles").addEventListener("click", () => {
  refreshProfiles().catch((error) => showMessage(error?.message || "无法读取账号", true));
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  startLoginButton.disabled = true;
  showMessage("正在创建一次性登录二维码…");
  try {
    const endpoint = document.querySelector("#endpoint").value.trim() || DEFAULT_ENDPOINT;
    localStorage.setItem("mainline-preview-endpoint", endpoint);
    const session = await window.mainlineAccounts.startLogin({
      endpoint,
      deviceName: document.querySelector("#deviceName").value.trim(),
    });
    activeSessionId = session.sessionId;
    loginQr.src = session.qrDataUrl;
    qrExpiry.textContent = `二维码在 ${new Date(session.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 前有效`;
    qrPanel.hidden = false;
    showMessage("请打开“主线随行笔记”小程序，点击“扫描电脑登录二维码”并确认");
    beginBoundedAutoChecks();
  } catch (error) {
    showMessage(error?.message || "无法生成登录二维码", true);
  } finally { startLoginButton.disabled = false; }
});

completeLoginButton.addEventListener("click", () => void checkLogin({ manual: true }));

cancelLoginButton.addEventListener("click", async () => {
  const sessionId = activeSessionId;
  stopAutoChecks();
  activeSessionId = "";
  qrPanel.hidden = true;
  loginQr.removeAttribute("src");
  if (sessionId) await window.mainlineAccounts.cancelLogin(sessionId).catch(() => {});
  showMessage("已取消本次扫码登录");
});

const rememberedEndpoint = localStorage.getItem("mainline-preview-endpoint");
document.querySelector("#endpoint").value = rememberedEndpoint || DEFAULT_ENDPOINT;
refreshProfiles().catch((error) => showMessage(error?.message || "无法读取账号", true));


