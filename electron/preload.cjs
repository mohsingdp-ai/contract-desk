// The only desktop features the page can reach: open or change the data folder.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  openDataFolder: () => ipcRenderer.invoke('data-folder:open'),
  chooseDataFolder: () => ipcRenderer.invoke('data-folder:choose'),
});
