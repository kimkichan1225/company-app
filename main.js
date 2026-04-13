const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFile } = require('child_process');

const CURRENT_VERSION = '1.0.0';
const VERSION_URL = 'https://raw.githubusercontent.com/kimkichan1225/company-app/main/version.json';

let workWin = null;   // 일하는 중 (데스크탑 펫)
let restWin = null;   // 휴식 중 (소통 창)
let tray = null;
let currentMode = 'work';

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

async function checkForUpdate() {
  try {
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
      buttons: ['업데이트', '나중에'],
      defaultId: 0,
    });

    if (result.response !== 0) return;

    // ZIP 다운로드
    const tmpDir = app.getPath('temp');
    const zipPath = path.join(tmpDir, 'fitcharacter_update.zip');
    const extractDir = path.join(tmpDir, 'fitcharacter_update');

    await downloadFile(remote.downloadUrl, zipPath);

    // 업데이트 배치 스크립트 작성
    const appDir = path.dirname(app.getPath('exe'));
    const batPath = path.join(tmpDir, 'fitcharacter_update.bat');
    const exePath = app.getPath('exe');

    const batContent = `@echo off
chcp 65001 >nul
echo Updating FitCharacter...
timeout /t 2 /nobreak >nul
rd /s /q "${extractDir}" 2>nul
mkdir "${extractDir}"
powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"
for /d %%i in ("${extractDir}\\*") do (
  xcopy /s /e /y "%%i\\*" "${appDir}\\" >nul
)
del "${zipPath}" 2>nul
rd /s /q "${extractDir}" 2>nul
start "" "${exePath}"
del "%~f0"
`;

    fs.writeFileSync(batPath, batContent, 'utf8');

    // 배치 실행 후 앱 종료
    execFile('cmd.exe', ['/c', 'start', '', '/min', batPath], { detached: true, stdio: 'ignore' });
    app.quit();
  } catch (err) {
    console.error('업데이트 확인 실패:', err.message);
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
});
