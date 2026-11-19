const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("editorApi", {
  initialize: () => ipcRenderer.invoke("editor:initialize"),
  reload: (encoding) => ipcRenderer.invoke("editor:reload", encoding),
  save: (file) => ipcRenderer.invoke("editor:save", file),
  dirty: (dirty) => ipcRenderer.send("editor:dirty", dirty),
});
