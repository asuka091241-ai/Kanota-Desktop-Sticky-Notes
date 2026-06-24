const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stickyAPI', {
  getData: () => ipcRenderer.invoke('sticky:getData'),
  onUpdate: (cb) => ipcRenderer.on('sticky:update', (_, d) => cb(d)),
  onContextCommand: (cb) => ipcRenderer.on('sticky:context-command', (_, cmd) => cb(cmd)),
  toggleCollapse: (collapsed) => ipcRenderer.send('sticky:toggleCollapse', collapsed),
  togglePin: (pinned) => ipcRenderer.send('sticky:togglePin', pinned),
  changeStatus: (flow) => ipcRenderer.send('sticky:changeStatus', flow),
  resize: (height) => ipcRenderer.send('sticky:resize', height),
  // Drag: renderer sends init/end; main polls cursor at high rate
  dragInit: (screenX, screenY) => ipcRenderer.send('sticky:dragInit', screenX, screenY),
  dragEnd: () => ipcRenderer.send('sticky:dragEnd'),
  // Resize: renderer sends init/end; main polls cursor at high rate
  resizeInit: (screenX, screenY, direction) => ipcRenderer.send('sticky:resizeInit', screenX, screenY, direction),
  resizeEnd: () => ipcRenderer.send('sticky:resizeEnd'),
  updateColor: (id, color) => ipcRenderer.invoke('sticky:updateColor', id, color),
  removeFromDesktop: (id) => ipcRenderer.invoke('sticky:removeFromDesktop', id),
  showContextMenu: (payload) => ipcRenderer.invoke('sticky:showContextMenu', payload),
  addPomoTime: (cardId, ms) => ipcRenderer.send('sticky:addPomoTime', cardId, ms),
  savePomoStats: (cardId, sessions, totalMin) => ipcRenderer.invoke('sticky:savePomoStats', cardId, sessions, totalMin),
});
