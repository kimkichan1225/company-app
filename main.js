const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFile } = require('child_process');
const { io: ioClient } = require('socket.io-client');

const CURRENT_VERSION = '1.1.4';
const VERSION_URL = 'https://raw.githubusercontent.com/kimkichan1225/company-app/main/version.json';
const SERVER_URL = 'https://web-production-3efa6.up.railway.app';

let workWin = null;   // 일하는 중 (데스크탑 펫)
let restWin = null;   // 휴식 중 (소통 창)
let tray = null;
let currentMode = 'work';

// ── socket.io 클라이언트 (main process에서 유지) ──
let clientSocket = null;
let savedSeat = null; // work 모드로 전환할 때 앉은 좌석 정보 (rest 복귀 시 사용)

function forwardSocketEvent(event, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('socket:event', { event, data });
    }
  }
}

function getClientSocket() {
  if (clientSocket) return clientSocket;
  clientSocket = ioClient(SERVER_URL, {
    transports: ['websocket', 'polling'],
    autoConnect: false,
    reconnection: true,
  });
  clientSocket.on('connect', () => forwardSocketEvent('connect', null));
  clientSocket.on('disconnect', () => forwardSocketEvent('disconnect', null));
  // 내 좌석 정보 캐싱 (work 모드 전환 시 서버 응답)
  clientSocket.on('user-mode-changed', (data) => {
    if (clientSocket && data && data.id === clientSocket.id) {
      if (data.mode === 'work' && data.seatIndex >= 0) {
        savedSeat = {
          seatIndex: data.seatIndex,
          x: data.x, y: data.y,
          direction: data.direction || 'back',
        };
      } else if (data.mode === 'rest') {
        savedSeat = null;
      }
    }
  });
  clientSocket.onAny((event, data) => forwardSocketEvent(event, data));
  return clientSocket;
}

// 파일 경로
const svgPath = path.join(__dirname, 'pixelated-cartoon-boy.svg');
const profilePath = path.join(app.getPath('userData'), 'profile.json');

// 프로필 관리
const DEFAULT_COLORS = { skin: '#fee7d5', hair: '#bb7750', top: '#df2210', pants: '#10a4df', shoes: '#762f08' };
const ORIGINAL_COLORS = { ...DEFAULT_COLORS };

function loadProfile() {
  try {
    if (fs.existsSync(profilePath)) {
      return JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
    }
  } catch (e) {}
  return null;
}

function saveProfile(profile) {
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf-8');
}

function hasProfile() {
  return fs.existsSync(profilePath);
}

// SVG에 커스텀 색상 적용
function getCustomSVG() {
  let svg = fs.readFileSync(svgPath, 'utf-8');
  const profile = loadProfile();
  if (profile && profile.colors) {
    const colorKeys = Object.keys(ORIGINAL_COLORS);
    for (const key of colorKeys) {
      const orig = ORIGINAL_COLORS[key];
      const custom = profile.colors[key];
      if (custom && orig !== custom) {
        svg = svg.replaceAll(`fill="${orig}"`, `fill="${custom}"`);
      }
    }
  }
  return svg;
}

let setupWin = null;

// ── 자동 업데이트 ──
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const get = (u) => {
      https.get(u, { headers: { 'User-Agent': 'FitCharacter' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location);
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) }));
      }).on('error', reject);
    };
    get(url);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) => {
      https.get(u, { headers: { 'User-Agent': 'FitCharacter' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location);
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    };
    get(url);
  });
}

// 업데이트 대기 마커 (자동 업데이트 실패 감지용)
const pendingUpdatePath = path.join(app.getPath('userData'), 'pending-update.json');

function writePendingUpdate(targetVersion, downloadUrl) {
  try {
    fs.writeFileSync(pendingUpdatePath, JSON.stringify({ targetVersion, downloadUrl }), 'utf8');
  } catch (e) {}
}

function readPendingUpdate() {
  try {
    if (fs.existsSync(pendingUpdatePath)) {
      return JSON.parse(fs.readFileSync(pendingUpdatePath, 'utf-8'));
    }
  } catch (e) {}
  return null;
}

function clearPendingUpdate() {
  try { if (fs.existsSync(pendingUpdatePath)) fs.unlinkSync(pendingUpdatePath); } catch (e) {}
}

const RELEASES_PAGE = 'https://github.com/kimkichan1225/company-app/releases/latest';

async function checkForUpdate() {
  try {
    // 이전 업데이트 시도가 실패했는지 먼저 확인
    const pending = readPendingUpdate();
    if (pending) {
      if (pending.targetVersion === CURRENT_VERSION) {
        // 업데이트 성공 — 마커 정리
        clearPendingUpdate();
      } else {
        // 버전이 올라가지 않았음 → 자동 업데이트 실패
        const parentWin = workWin || restWin;
        const fallback = await dialog.showMessageBox(parentWin, {
          type: 'warning',
          title: '업데이트 실패',
          message: `이전 자동 업데이트가 실패했습니다.\n현재 ${CURRENT_VERSION}, 목표 ${pending.targetVersion}\n\n수동 다운로드 페이지를 여시겠습니까?`,
          buttons: ['다운로드 페이지 열기', '나중에'],
          defaultId: 0,
        });
        clearPendingUpdate();
        if (fallback.response === 0) {
          shell.openExternal(pending.downloadUrl || RELEASES_PAGE);
        }
        return;
      }
    }

    const res = await httpGet(VERSION_URL);
    if (res.statusCode !== 200) return;

    const remote = JSON.parse(res.body.toString());
    if (remote.version === CURRENT_VERSION) return;

    // 업데이트 가능한 윈도우 찾기
    const parentWin = workWin || restWin;
    const result = await dialog.showMessageBox(parentWin, {
      type: 'info',
      title: '업데이트',
      message: `새 버전 ${remote.version}이 있습니다. (현재 ${CURRENT_VERSION})\n업데이트 하시겠습니까?`,
      buttons: ['자동 업데이트', '수동 다운로드', '나중에'],
      defaultId: 0,
      cancelId: 2,
    });

    if (result.response === 2) return;
    if (result.response === 1) {
      shell.openExternal(remote.downloadUrl || RELEASES_PAGE);
      return;
    }

    // ZIP 다운로드
    const tmpDir = app.getPath('temp');
    const zipPath = path.join(tmpDir, 'fitcharacter_update.zip');
    const extractDir = path.join(tmpDir, 'fitcharacter_update');

    await downloadFile(remote.downloadUrl, zipPath);

    // PowerShell 업데이트 스크립트 작성
    // (cmd 배치는 한글 경로 + cp949/UTF-8 인코딩 문제가 반복되어 PowerShell로 대체)
    const appDir = path.dirname(app.getPath('exe'));
    const ps1Path = path.join(tmpDir, 'fitcharacter_update.ps1');
    const exePath = app.getPath('exe');

    // PS1 단일따옴표는 리터럴 문자열 (이스케이프 불필요, 경로에 ' 없다고 가정)
    const ps1Content = `
$ErrorActionPreference = 'Stop'
$zipPath    = '${zipPath}'
$extractDir = '${extractDir}'
$appDir     = '${appDir}'
$exePath    = '${exePath}'
$logPath    = Join-Path $env:TEMP 'fitcharacter_update.log'

function Write-Log($msg) {
  $ts = Get-Date -Format 'HH:mm:ss'
  Add-Content -Path $logPath -Value "[$ts] $msg" -Encoding UTF8
}

Set-Content -Path $logPath -Value "--- FitCharacter update log ---" -Encoding UTF8

try {
  Write-Log "Update start, appDir=$appDir"

  # Electron 프로세스가 완전히 종료될 때까지 exe 락 해제 대기 (최대 20초)
  $unlockWait = 0
  while ($unlockWait -lt 40) {
    try {
      $fs = [System.IO.File]::Open($exePath, 'Open', 'ReadWrite', 'None')
      $fs.Close()
      Write-Log "Exe unlocked after ${unlockWait}x500ms"
      break
    } catch {
      Start-Sleep -Milliseconds 500
      $unlockWait++
    }
  }

  # ZIP 압축 해제
  Write-Log "Extracting ZIP..."
  if (Test-Path $extractDir) { Remove-Item -Path $extractDir -Recurse -Force }
  New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
  Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

  # 파일 복사 — 락이 풀리지 않은 파일이 있을 수 있어 최대 15회 재시도
  $maxRetries = 15
  $copied = $false
  for ($i = 0; $i -lt $maxRetries; $i++) {
    try {
      Copy-Item -Path (Join-Path $extractDir '*') -Destination $appDir -Recurse -Force -ErrorAction Stop
      Write-Log "Copy success on attempt $($i+1)"
      $copied = $true
      break
    } catch {
      Write-Log "Copy attempt $($i+1) failed: $($_.Exception.Message)"
      Start-Sleep -Seconds 1
    }
  }
  if (-not $copied) { throw "Copy failed after $maxRetries retries" }

  # 정리
  Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue
  Remove-Item -Path $extractDir -Recurse -Force -ErrorAction SilentlyContinue

  Write-Log "Starting new exe..."
  Start-Process -FilePath $exePath
  Write-Log "Update complete"
} catch {
  Write-Log "FATAL: $($_ | Out-String)"
  # 업데이트 실패 시 GitHub 릴리즈 페이지 폴백
  Start-Process 'https://github.com/kimkichan1225/company-app/releases/latest'
}
`;

    // UTF-8 BOM 포함으로 저장 → PowerShell이 한글 경로를 정확히 읽음
    fs.writeFileSync(ps1Path, '\uFEFF' + ps1Content, 'utf8');

    // 실패 감지용 마커 기록
    writePendingUpdate(remote.version, remote.downloadUrl);

    // PowerShell 실행 후 앱 종료
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1Path],
      { detached: true, stdio: 'ignore' });
    app.quit();
  } catch (err) {
    console.error('업데이트 확인 실패:', err.message);
    const parentWin = workWin || restWin;
    if (parentWin) {
      const fallback = await dialog.showMessageBox(parentWin, {
        type: 'warning',
        title: '업데이트 중 오류',
        message: `업데이트 중 오류가 발생했습니다.\n${err.message}\n\n수동 다운로드 페이지를 여시겠습니까?`,
        buttons: ['다운로드 페이지 열기', '닫기'],
        defaultId: 0,
      });
      if (fallback.response === 0) shell.openExternal(RELEASES_PAGE);
    }
  }
}

function createWorkWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  workWin = new BrowserWindow({
    width: 140,
    height: 160,
    x: Math.floor(width / 2),
    y: height - 160,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  workWin.loadFile('work.html');
  workWin.setIgnoreMouseEvents(false);
  workWin.setAlwaysOnTop(true, 'screen-saver');

  // 화면 정보 전달 + 업데이트 체크
  workWin.webContents.on('did-finish-load', () => {
    workWin.webContents.send('screen-bounds', {
      width: display.workAreaSize.width,
      height: display.workAreaSize.height,
    });
    checkForUpdate();
  });

  workWin.on('closed', () => {
    workWin = null;
  });
}

function createRestWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  restWin = new BrowserWindow({
    width: 800,
    height: 600,
    x: Math.floor((width - 800) / 2),
    y: Math.floor((height - 600) / 2),
    frame: false,
    resizable: true,
    transparent: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  restWin.loadFile('rest.html');

  restWin.on('closed', () => {
    restWin = null;
    // 휴식 창 닫으면 일하기 모드로 복귀
    if (currentMode === 'rest') {
      currentMode = 'work';
      createWorkWindow();
    }
  });
}

// 모드 전환
function switchMode(mode) {
  if (mode === 'rest' && currentMode === 'work') {
    currentMode = 'rest';
    if (workWin) { workWin.destroy(); workWin = null; }
    createRestWindow();
  } else if (mode === 'work' && currentMode === 'rest') {
    currentMode = 'work';
    if (restWin) { restWin.destroy(); restWin = null; }
    setTimeout(() => createWorkWindow(), 200);
  }
}

// 트레이 아이콘 생성
function createTray() {
  // 간단한 16x16 아이콘 생성
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVQ4T2P8z8BQz0BAwMCIBDCKGBhYGP4zMDIwICsAMRgYGP4zMDAwoOuBmUL/GQBR3REREfXJYQAAAABJRU5ErkJggg=='
  );
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: `FitCharacter v${CURRENT_VERSION}`, enabled: false },
    { type: 'separator' },
    {
      label: '일하는 중',
      type: 'radio',
      checked: true,
      click: () => switchMode('work'),
    },
    {
      label: '휴식 중',
      type: 'radio',
      click: () => switchMode('rest'),
    },
    { type: 'separator' },
    {
      label: '프로필 수정',
      click: () => openSetupForEdit(),
    },
    {
      label: '업데이트 확인',
      click: () => checkForUpdate(),
    },
    {
      label: '종료',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Fit Character');
  tray.setContextMenu(contextMenu);

  // 트레이 더블클릭으로 모드 전환
  tray.on('double-click', () => {
    if (currentMode === 'work') {
      switchMode('rest');
    } else {
      switchMode('work');
    }
  });
}

// IPC 핸들러
ipcMain.on('move-window', (event, { x, y }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.setPosition(Math.round(x), Math.round(y));
  }
});

ipcMain.on('get-position', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    const pos = win.getPosition();
    event.returnValue = { x: pos[0], y: pos[1] };
  } else {
    event.returnValue = { x: 0, y: 0 };
  }
});

ipcMain.on('switch-mode', (event, mode) => {
  switchMode(mode);
});

// ── socket bridge IPC ──
ipcMain.handle('socket:connect', async (_, joinData) => {
  const s = getClientSocket();
  if (s.connected) {
    s.emit('join', joinData);
    return { id: s.id, connected: true };
  }
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      s.off('connect', onConnect);
      s.off('connect_error', onError);
    };
    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      s.emit('join', joinData);
      resolve({ id: s.id, connected: true });
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ id: null, connected: false, error: err && err.message });
    };
    s.once('connect', onConnect);
    s.once('connect_error', onError);
    s.connect();
  });
});

ipcMain.on('socket:emit', (_, payload) => {
  if (clientSocket && clientSocket.connected) {
    clientSocket.emit(payload.event, payload.data);
  }
});

ipcMain.on('socket:disconnect', () => {
  if (clientSocket) {
    clientSocket.disconnect();
    clientSocket = null;
  }
  savedSeat = null;
});

ipcMain.handle('socket:get-id', async () => {
  return clientSocket ? clientSocket.id : null;
});

ipcMain.handle('socket:is-connected', async () => {
  return !!(clientSocket && clientSocket.connected);
});

ipcMain.handle('socket:get-saved-seat', async () => {
  return savedSeat;
});

ipcMain.on('socket:clear-saved-seat', () => {
  savedSeat = null;
});

ipcMain.on('quit-app', () => {
  app.isQuitting = true;
  app.quit();
});

// 네이티브 우클릭 메뉴
ipcMain.on('show-context-menu', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const menu = Menu.buildFromTemplate([
    { label: '☕ 휴식 모드', click: () => switchMode('rest') },
    { label: '✏️ 프로필 수정', click: () => openSetupForEdit() },
    { type: 'separator' },
    { label: '종료', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  menu.popup({ window: win });
});

// 프로필 수정 화면 열기
function openSetupForEdit() {
  if (setupWin) return;
  if (workWin) { workWin.destroy(); workWin = null; }
  if (restWin) { restWin.destroy(); restWin = null; }
  // destroy 후 약간 대기해서 소켓이 끊기도록
  setTimeout(() => createSetupWindow(), 200);
}

ipcMain.on('open-setup', () => {
  openSetupForEdit();
});


// 원본 SVG 반환 (성별에 따라 다른 파일)
ipcMain.handle('read-svg', async (event, gender) => {
  // gender가 지정되면 해당 파일, 아니면 프로필에서 확인
  let g = gender;
  if (!g) {
    const profile = loadProfile();
    g = (profile && profile.gender) || 'boy';
  }
  const fileName = g === 'girl' ? 'pixelated-cartoon-girl.svg' : 'pixelated-cartoon-boy.svg';
  return fs.readFileSync(path.join(__dirname, fileName), 'utf-8');
});

// 프로필 IPC
ipcMain.handle('save-profile', async (event, profile) => {
  saveProfile(profile);
  return true;
});

ipcMain.handle('load-profile', async () => {
  return loadProfile();
});

ipcMain.handle('has-profile', async () => {
  return hasProfile();
});

// 셋업 완료 → Work 모드로
ipcMain.on('setup-done', () => {
  if (setupWin) {
    setupWin.close();
    setupWin = null;
  }
  createWorkWindow();
});

// 셋업 윈도우
function createSetupWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  setupWin = new BrowserWindow({
    width: 520,
    height: 580,
    x: Math.floor((width - 520) / 2),
    y: Math.floor((height - 580) / 2),
    frame: false,
    resizable: false,
    transparent: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  setupWin.loadFile('setup.html');

  setupWin.on('closed', () => {
    setupWin = null;
    if (!hasProfile()) {
      // 첫 셋업 안 하고 닫으면 앱 종료
      app.quit();
    } else if (!workWin && !restWin) {
      // 프로필 수정 후 닫으면 work 모드로 복귀
      currentMode = 'work';
      createWorkWindow();
    }
  });
}

// 앱 시작
app.whenReady().then(() => {
  createTray();
  if (hasProfile()) {
    createWorkWindow();
  } else {
    createSetupWindow();
  }
});

app.on('window-all-closed', () => {
  // 트레이에 남아있으므로 종료하지 않음
});

app.on('before-quit', () => {
  if (tray) tray.destroy();
  if (clientSocket) {
    try { clientSocket.disconnect(); } catch (e) {}
    clientSocket = null;
  }
});
