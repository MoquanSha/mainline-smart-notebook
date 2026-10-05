function showOrCreateMainWindow({ mainWindow, serverUrl, createWindow }) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return serverUrl ? createWindow() : null;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  return mainWindow;
}

module.exports = { showOrCreateMainWindow };
