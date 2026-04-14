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
  readSVG: (gender) => ipcRenderer.invoke('read-svg', gender),

  // 프로필 저장/로드
  saveProfile: (profile) => ipcRenderer.invoke('save-profile', profile),
  loadProfile: () => ipcRenderer.invoke('load-profile'),
  hasProfile: () => ipcRenderer.invoke('has-profile'),

  // 셋업 완료
  setupDone: () => ipcRenderer.send('setup-done'),

  // 앱 종료
  quitApp: () => ipcRenderer.send('quit-app'),

  // 프로필 수정 화면 열기
  openSetup: () => ipcRenderer.send('open-setup'),

  // 우클릭 메뉴 표시
  showContextMenu: () => ipcRenderer.send('show-context-menu'),

  // 윈도우 크기 변경 (말풍선용)
  expandWindow: () => ipcRenderer.send('expand-window'),
  shrinkWindow: () => ipcRenderer.send('shrink-window'),

  // Socket.io 브리지 (main process에서 연결 유지)
  socketConnect: (joinData) => ipcRenderer.invoke('socket:connect', joinData),
  socketEmit: (event, data) => ipcRenderer.send('socket:emit', { event, data }),
  socketDisconnect: () => ipcRenderer.send('socket:disconnect'),
  getSocketId: () => ipcRenderer.invoke('socket:get-id'),
  isSocketConnected: () => ipcRenderer.invoke('socket:is-connected'),
  getSavedSeat: () => ipcRenderer.invoke('socket:get-saved-seat'),
  clearSavedSeat: () => ipcRenderer.send('socket:clear-saved-seat'),
  onSocketEvent: (eventName, callback) => {
    const handler = (_, msg) => { if (msg.event === eventName) callback(msg.data); };
    ipcRenderer.on('socket:event', handler);
    return () => ipcRenderer.removeListener('socket:event', handler);
  },
});
