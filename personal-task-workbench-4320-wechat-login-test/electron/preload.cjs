const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mainlineCloud", {
  pair: (options) => ipcRenderer.invoke("mainline-cloud:pair", options),
  sync: () => ipcRenderer.invoke("mainline-cloud:sync"),
  status: () => ipcRenderer.invoke("mainline-cloud:status"),
  disconnect: () => ipcRenderer.invoke("mainline-cloud:disconnect"),
  onRemoteApplied: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("mainline-cloud:remote-applied", handler);
    return () => ipcRenderer.removeListener("mainline-cloud:remote-applied", handler);
  },
});

contextBridge.exposeInMainWorld("mainlineHome", {
  status: () => ipcRenderer.invoke("mainline-home:status"),
  setPublicUrl: (publicUrl) => ipcRenderer.invoke("mainline-home:set-public-url", publicUrl),
  configureTunnel: (options) => ipcRenderer.invoke("mainline-home:configure-tunnel", options),
  restartTunnel: () => ipcRenderer.invoke("mainline-home:restart-tunnel"),
  disconnectTunnel: () => ipcRenderer.invoke("mainline-home:disconnect-tunnel"),
});

contextBridge.exposeInMainWorld("mainlineAccounts", {
  list: () => ipcRenderer.invoke("mainline-profile:list"),
  current: () => ipcRenderer.invoke("mainline-profile:current"),
  switchAccount: () => ipcRenderer.invoke("mainline-profile:switch"),
  logout: () => ipcRenderer.invoke("mainline-profile:logout"),
});
