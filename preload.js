const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 윈도우 이동
  moveWindow: (x, y) => ipcRenderer.send('move-window', { x, y }),
  getPosition: () => ipcRenderer.sendSync('get-position'),

  // 화면 정보
  onScreenBounds: (callback) => ipcRenderer.on('screen-bounds', (e, bounds) => callback(bounds)),

  // 모드 전환
  switchToRest: () => ipcRenderer.send('switch-mode', 'rest'),
  switchToWork: () => ipcRenderer.send('switch-mode', 'work'),

  // SVG 파일 읽기 (커스텀 색상 적용된 버전)
  readSVG: () => ipcRenderer.invoke('read-svg'),

  // 프로필 저장/로드
  saveProfile: (profile) => ipcRenderer.invoke('save-profile', profile),
  loadProfile: () => ipcRenderer.invoke('load-profile'),
  hasProfile: () => ipcRenderer.invoke('has-profile'),

  // 셋업 완료
  setupDone: () => ipcRenderer.send('setup-done'),

  // 앱 종료
  quitApp: () => ipcRenderer.send('quit-app'),

});
