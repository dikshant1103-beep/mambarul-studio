const { contextBridge } = require('electron')

// Expose minimal safe API to renderer — currently none needed
// since the app communicates purely via HTTP to localhost:8000
contextBridge.exposeInMainWorld('mambaRUL', {
  version: '1.0.0',
  platform: process.platform,
})
