const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("editorApi", {
  initialize: () => ipcRenderer.invoke("editor:initialize"),
  reload: (encoding) => ipcRenderer.invoke("editor:reload", encoding),
  save: (file) => ipcRenderer.invoke("editor:save", file),
  dirty: (dirty) => ipcRenderer.send("editor:dirty", dirty),
  onSettings: (callback) => {
    const listener = (_event, message) => {
      if (message.type === "settings-changed") callback(message.settings);
    };
    ipcRenderer.on("window:event", listener);
    return () => ipcRenderer.removeListener("window:event", listener);
  },
});
