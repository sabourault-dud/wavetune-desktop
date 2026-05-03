const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('wt', {
  // Library
  getLibrary:        ()               => ipcRenderer.invoke('get-library'),
  saveCustomLists:   (lists, covers)  => ipcRenderer.invoke('save-custom-lists', lists, covers),
  saveTrackMeta:     (meta)           => ipcRenderer.invoke('save-track-meta', meta),
  resyncItunes:      ()               => ipcRenderer.invoke('resync-itunes'),
  clearScanCache:    ()               => ipcRenderer.invoke('clearScanCache'),
  setOnboardingDone: ()               => ipcRenderer.invoke('set-onboarding-done'),
  pickFolder:        ()               => ipcRenderer.invoke('pickFolder'),
  connectItunes:     (m)              => ipcRenderer.invoke('connectItunes', m),
  getIP:             ()               => ipcRenderer.invoke('getIP'),
  getPort:           ()               => ipcRenderer.invoke('getPort'),
  openPath:          (p)              => ipcRenderer.invoke('openPath', p),
  fingerprintFile:   (p)              => ipcRenderer.invoke('fingerprint-file', p),
  acoustidAvailable: ()               => ipcRenderer.invoke('acoustid-available'),
  revealInFinder:    (p)              => ipcRenderer.invoke('revealInFinder', p),
  openCoverWindow:    (data)           => ipcRenderer.invoke('openCoverWindow', data),
  applyCoverToMain:   (payload)        => ipcRenderer.invoke('applyCoverToMain', payload),
  applyTrackMetaToMain:(payload)       => ipcRenderer.invoke('applyTrackMetaToMain', payload),
  setFullscreen:     (flag)           => ipcRenderer.invoke('setFullscreen', flag),
  readAudioFile:      (filePath)       => ipcRenderer.invoke('read-audio-file', filePath),
  shazamRecognize: (audioData) => ipcRenderer.invoke('shazam-recognize', audioData),
  // Online metadata fetch (runs in main process — no CSP limits)
  fetchOnlineMeta:   (albumGroups)    => ipcRenderer.invoke('fetch-online-meta', albumGroups),
  getArtistOverrides:()               => ipcRenderer.invoke('get-artist-overrides'),
  // Sync server (HTTP léger smartphone)
  syncSetTracks:     (tracks)         => ipcRenderer.invoke('sync-set-tracks', tracks),
  // Mini player
  miniReady:     ()        => ipcRenderer.invoke('miniReady'),
  miniCmd:       (action)  => ipcRenderer.invoke('miniCmd', action),
  resizeMini:    (h)       => ipcRenderer.invoke('resizeMini', h),
  // Events
  on: (ch, cb) => ipcRenderer.on(ch, (_, d) => cb(d)),
});
