import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('nextnoteNative', {
  http: (req: unknown) => ipcRenderer.invoke('http', req),
  openExternal: (url: string) => ipcRenderer.invoke('openExternal', url),
  oauthAuthorize: (authorizeUrl: string) => ipcRenderer.invoke('oauthAuthorize', authorizeUrl),
  oauthCancel: () => ipcRenderer.invoke('oauthCancel'),
  secureGet: (key: string) => ipcRenderer.invoke('secureGet', key),
  secureSet: (key: string, value: string | null) => ipcRenderer.invoke('secureSet', key, value),
  onFocus: (cb: () => void) => {
    ipcRenderer.on('focus', () => cb());
  },
  clipboardRead: () => ipcRenderer.invoke('clipboardRead'),
  clipboardWriteText: (text: string) => ipcRenderer.invoke('clipboardWriteText', text),
  os: process.platform,
  version: '1.3.0',
});
