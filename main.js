const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

let workWin = null;   // 일하는 중 (데스크탑 펫)
let restWin = null;   // 휴식 중 (소통 창)
let tray = null;
let currentMode = 'work';

// SVG 파일 경로
const svgPath = path.join(__dirname, 'pixelated-cartoon-boy.svg');

function createWorkWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  workWin = new BrowserWindow({
    width: 100,
    height: 120,
    x: Math.floor(width / 2),
    y: height - 120,
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

  // 화면 정보 전달
  workWin.webContents.on('did-finish-load', () => {
    workWin.webContents.send('screen-bounds', {
      width: display.workAreaSize.width,
      height: display.workAreaSize.height,
    });
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
    if (workWin) {
      workWin.close();
      workWin = null;
    }
    createRestWindow();
  } else if (mode === 'work' && currentMode === 'rest') {
    currentMode = 'work';
    if (restWin) {
      restWin.close();
      restWin = null;
    }
    createWorkWindow();
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

// SVG 읽기
ipcMain.handle('read-svg', async () => {
  return fs.readFileSync(svgPath, 'utf-8');
});

// 앱 시작
app.whenReady().then(() => {
  createTray();
  createWorkWindow();
});

app.on('window-all-closed', () => {
  // 트레이에 남아있으므로 종료하지 않음
});

app.on('before-quit', () => {
  if (tray) tray.destroy();
});
