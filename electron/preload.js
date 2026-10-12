'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  setClickThrough: (v) => ipcRenderer.send('pet:click-through', v),
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  quit: () => ipcRenderer.send('pet:quit'),
  resize: (width, height) => ipcRenderer.send('pet:resize', { width, height }),
  listDir: (rel) => ipcRenderer.invoke('pet:list-dir', rel),
  probe: () => ipcRenderer.invoke('pet:probe'),
  moveBy: (dx, dy) => ipcRenderer.send('pet:move-by', { dx, dy }),
  saveCapture: (dataUrl) => ipcRenderer.invoke('pet:save-capture', dataUrl),
  log: (line) => ipcRenderer.invoke('pet:log', String(line)),
  onCursor: (cb) => ipcRenderer.on('pet:cursor', (_e, x, y) => cb(x, y)),
  onCapture: (cb) => ipcRenderer.on('pet:capture', () => cb()),
  captureDone: (out) => ipcRenderer.send('pet:capture-done', String(out)),
});
