const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mainlineAccounts", {
  list: () => ipcRenderer.invoke("mainline-profile:list"),
  current: () => ipcRenderer.invoke("mainline-profile:current"),
  activate: (profileKey) => ipcRenderer.invoke("mainline-profile:activate", profileKey),
  startLogin: (options) => ipcRenderer.invoke("mainline-profile:login-start", options),
  completeLogin: (sessionId) => ipcRenderer.invoke("mainline-profile:login-complete", sessionId),
  cancelLogin: (sessionId) => ipcRenderer.invoke("mainline-profile:login-cancel", sessionId),
  createTest: (suffix) => ipcRenderer.invoke("mainline-profile:create-test", suffix),
});
