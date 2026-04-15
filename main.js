const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFile } = require('child_process');
const { io: ioClient } = require('socket.io-client');

const CURRENT_VERSION = '1.1.31';
const VERSION_URL = 'https://raw.githubusercontent.com/kimkichan1225/company-app/main/version.json';
const SERVER_URL = 'https://web-production-3efa6.up.railway.app';

let workWin = null;   // 일하는 중 (데스크탑 펫)
let restWin = null;   // 휴식 중 (소통 창)
let tray = null;
let currentMode = 'rest';

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

// 업데이트 결과 기록 파일 (PS가 작성, Electron이 다음 실행에서 읽음)
const updateResultPath = path.join(app.getPath('userData'), 'update-result.json');

function readUpdateResult() {
  try {
    if (fs.existsSync(updateResultPath)) {
      return JSON.parse(fs.readFileSync(updateResultPath, 'utf-8'));
    }
  } catch (e) {}
  return null;
}

function clearUpdateResult() {
  try { if (fs.existsSync(updateResultPath)) fs.unlinkSync(updateResultPath); } catch (e) {}
}

// 시맨틱 버전 비교 (a > b: 1, a < b: -1, 같으면 0)
function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

const RELEASES_PAGE = 'https://github.com/kimkichan1225/company-app/releases/latest';

// 이전 업데이트 결과 확인 (앱 시작 직후 호출)
async function handlePreviousUpdateResult() {
  const result = readUpdateResult();
  if (!result) return;
  clearUpdateResult();

  if (result.status === 'success') {
    await dialog.showMessageBox({
      type: 'info',
      title: '업데이트 완료',
      message: `FitCharacter가 v${result.version || CURRENT_VERSION}로 업데이트되었습니다.`,
      buttons: ['확인'],
    });
  } else if (result.status === 'failed') {
    const r = await dialog.showMessageBox({
      type: 'error',
      title: '업데이트 실패',
      message: '이전 업데이트가 실패했습니다.',
      detail: result.error ? `원인: ${result.error}` : '',
      buttons: ['다운로드 페이지 열기', '닫기'],
      defaultId: 0,
    });
    if (r.response === 0) shell.openExternal(RELEASES_PAGE);
  } else if (result.status === 'in_progress') {
    // PS가 완료 전에 중단됨
    const r = await dialog.showMessageBox({
      type: 'warning',
      title: '업데이트 중단됨',
      message: '이전 업데이트가 완료되지 못했습니다.',
      detail: '수동 다운로드로 설치를 마칠 수 있습니다.',
      buttons: ['다운로드 페이지 열기', '닫기'],
      defaultId: 0,
    });
    if (r.response === 0) shell.openExternal(RELEASES_PAGE);
  }
}

// 업데이트 확인 및 진행 (true 반환 시 앱이 종료 절차에 진입)
async function checkForUpdate() {
  try {
    const res = await httpGet(VERSION_URL);
    if (res.statusCode !== 200) return false;

    const remote = JSON.parse(res.body.toString());
    if (compareVersions(remote.version, CURRENT_VERSION) <= 0) return false;

    // 업데이트 가능 안내 다이얼로그
    const result = await dialog.showMessageBox({
      type: 'info',
      title: '업데이트 가능',
      message: `새 버전 ${remote.version}이 있습니다.`,
      detail: `현재: ${CURRENT_VERSION}\n새 버전: ${remote.version}\n\n업데이트 시 앱이 종료되고, 설치 완료 후 앱을 다시 실행해주세요.`,
      buttons: ['업데이트', '수동 다운로드', '나중에'],
      defaultId: 0,
      cancelId: 2,
    });

    if (result.response === 2) return false;
    if (result.response === 1) {
      shell.openExternal(remote.downloadUrl || RELEASES_PAGE);
      return false;
    }

    // 다운로드 중 (간단한 안내 없이 블로킹 다운로드 — 대개 빠름)
    const tmpDir = app.getPath('temp');
    const zipPath = path.join(tmpDir, 'fitcharacter_update.zip');
    const extractDir = path.join(tmpDir, 'fitcharacter_update');

    await downloadFile(remote.downloadUrl, zipPath);

    // PS 업데이터 스크립트 작성 (완전 숨김 모드, GUI 없음)
    const appDir = path.dirname(app.getPath('exe'));
    const ps1Path = path.join(tmpDir, 'fitcharacter_update.ps1');
    const exePath = app.getPath('exe');
    const resultPath = updateResultPath;
    const logPath = path.join(tmpDir, 'fitcharacter_update.log');

    const ps1Content = `
$ErrorActionPreference = 'Stop'
$zipPath     = '${zipPath}'
$extractDir  = '${extractDir}'
$appDir      = '${appDir}'
$exePath     = '${exePath}'
$resultPath  = '${resultPath}'
$logPath     = '${logPath}'
$targetVer   = '${remote.version}'

# WinForms 기반 진행 상황 GUI
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'FitCharacter 업데이트'
$form.Size = New-Object System.Drawing.Size(470, 200)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ControlBox = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(26, 26, 46)

$title = New-Object System.Windows.Forms.Label
$title.Text = 'FitCharacter 업데이트 설치 중'
$title.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = [System.Drawing.Color]::White
$title.Location = New-Object System.Drawing.Point(20, 18)
$title.Size = New-Object System.Drawing.Size(430, 28)
$form.Controls.Add($title)

$status = New-Object System.Windows.Forms.Label
$status.Text = '준비 중...'
$status.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$status.ForeColor = [System.Drawing.Color]::FromArgb(180, 200, 230)
$status.Location = New-Object System.Drawing.Point(20, 56)
$status.Size = New-Object System.Drawing.Size(430, 22)
$form.Controls.Add($status)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Location = New-Object System.Drawing.Point(20, 90)
$bar.Size = New-Object System.Drawing.Size(430, 25)
$bar.Minimum = 0
$bar.Maximum = 100
$bar.Value = 0
$form.Controls.Add($bar)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = '설치 완료 후 이 창이 자동으로 닫힙니다. 닫지 마세요.'
$hint.Font = New-Object System.Drawing.Font('Segoe UI', 8)
$hint.ForeColor = [System.Drawing.Color]::FromArgb(140, 160, 190)
$hint.Location = New-Object System.Drawing.Point(20, 128)
$hint.Size = New-Object System.Drawing.Size(430, 20)
$form.Controls.Add($hint)

function Update-UI($value, $text) {
  $bar.Value = [Math]::Min(100, [Math]::Max(0, $value))
  $status.Text = $text
  [System.Windows.Forms.Application]::DoEvents()
}

function Write-Log($msg) {
  $ts = Get-Date -Format 'HH:mm:ss'
  Add-Content -Path $logPath -Value "[$ts] $msg" -Encoding UTF8
}

function Write-Result($st, $err) {
  $obj = [ordered]@{
    status = $st
    version = $targetVer
    error = $err
    time = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
  }
  ($obj | ConvertTo-Json -Compress) | Out-File -FilePath $resultPath -Encoding UTF8 -Force
}

Set-Content -Path $logPath -Value "--- FitCharacter GUI update log ---" -Encoding UTF8
Write-Log "Update start, target=$targetVer"
Write-Result 'in_progress' $null

$form.Show()
[System.Windows.Forms.Application]::DoEvents()

try {
  Update-UI 10 '이전 프로세스 종료 대기 중...'
  Write-Log 'Waiting for exe unlock'
  $waited = 0
  while ($waited -lt 60) {
    try {
      $fs = [System.IO.File]::Open($exePath, 'Open', 'ReadWrite', 'None')
      $fs.Close()
      break
    } catch {
      Start-Sleep -Milliseconds 500
      $waited++
      [System.Windows.Forms.Application]::DoEvents()
    }
  }
  Write-Log "Unlocked after $waited x 500ms"

  Update-UI 30 '업데이트 파일 압축 해제 중...'
  if (Test-Path $extractDir) { Remove-Item -Path $extractDir -Recurse -Force }
  New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
  Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
  Write-Log 'Extracted'

  Update-UI 50 '파일 복사 중...'
  $copied = $false
  for ($i = 0; $i -lt 15; $i++) {
    try {
      Copy-Item -Path (Join-Path $extractDir '*') -Destination $appDir -Recurse -Force -ErrorAction Stop
      $copied = $true
      Write-Log "Copy success on attempt $($i+1)"
      break
    } catch {
      Update-UI 50 "파일 복사 재시도 중... ($($i+1)/15)"
      Write-Log "Copy attempt $($i+1) failed: $($_.Exception.Message)"
      Start-Sleep -Seconds 1
      [System.Windows.Forms.Application]::DoEvents()
    }
  }
  if (-not $copied) { throw '파일 복사 실패 (15회 재시도 후 중단)' }

  Update-UI 90 '정리 중...'
  Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue
  Remove-Item -Path $extractDir -Recurse -Force -ErrorAction SilentlyContinue

  Update-UI 100 '업데이트 완료!'
  $title.Text = '✓ 업데이트 완료'
  $title.ForeColor = [System.Drawing.Color]::FromArgb(46, 204, 113)
  $hint.Text = 'FitCharacter를 다시 실행해주세요. 3초 후 창이 자동으로 닫힙니다.'
  [System.Windows.Forms.Application]::DoEvents()

  Write-Log 'Update complete'
  Write-Result 'success' $null

  Start-Sleep -Seconds 3
  $form.Close()
} catch {
  Write-Log "FATAL: $($_.Exception.Message)"
  Write-Result 'failed' $_.Exception.Message

  $title.Text = '✗ 업데이트 실패'
  $title.ForeColor = [System.Drawing.Color]::FromArgb(231, 76, 60)
  $status.Text = $_.Exception.Message
  $bar.Value = 0
  $hint.Text = '10초 후 창이 자동으로 닫힙니다.'
  [System.Windows.Forms.Application]::DoEvents()

  Start-Sleep -Seconds 10
  $form.Close()
}
`;

    // UTF-8 BOM 포함으로 저장 → PowerShell이 한글 경로를 정확히 읽음
    fs.writeFileSync(ps1Path, '\uFEFF' + ps1Content, 'utf8');

    // 설치 안내 → 사용자에게 앱 종료 예고
    await dialog.showMessageBox({
      type: 'info',
      title: '설치 준비 완료',
      message: '업데이트 파일이 준비되었습니다.',
      detail: '"확인"을 누르면 앱이 종료됩니다.\n\n별도 진행 상황 창이 열려 설치를 진행하고\n완료되면 자동으로 닫힙니다.\n\n설치 후 FitCharacter를 다시 실행해주세요.',
      buttons: ['확인'],
    });

    // cmd /c start 래핑으로 독립 프로세스 실행 (Electron 종료와 무관)
    // PS 콘솔은 -WindowStyle Hidden으로 숨기고, WinForms 다이얼로그만 표시
    const child = execFile('cmd.exe',
      ['/c', 'start', '', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1Path],
      { detached: true, stdio: 'ignore' });
    child.unref();

    // PS 기동 시간 확보 후 종료 (WinForms 초기화 여유)
    setTimeout(() => app.quit(), 1500);
    return true;
  } catch (err) {
    console.error('업데이트 확인 실패:', err.message);
    const r = await dialog.showMessageBox({
      type: 'warning',
      title: '업데이트 중 오류',
      message: '업데이트 중 오류가 발생했습니다.',
      detail: `${err.message}\n\n수동 다운로드 페이지를 여시겠습니까?`,
      buttons: ['다운로드 페이지 열기', '닫기'],
      defaultId: 0,
    });
    if (r.response === 0) shell.openExternal(RELEASES_PAGE);
    return false;
  }
}

// 모든 모니터를 합친 데스크탑 전체 영역 (작업표시줄 제외) 반환
function getCombinedDesktopBounds() {
  const displays = screen.getAllDisplays();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of displays) {
    const wa = d.workArea; // { x, y, width, height }
    minX = Math.min(minX, wa.x);
    minY = Math.min(minY, wa.y);
    maxX = Math.max(maxX, wa.x + wa.width);
    maxY = Math.max(maxY, wa.y + wa.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function createWorkWindow() {
  const bounds = getCombinedDesktopBounds();

  workWin = new BrowserWindow({
    width: 140,
    height: 160,
    x: Math.floor(bounds.x + bounds.width / 2),
    y: bounds.y + bounds.height - 160,
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

  // 화면 정보 전달 (전체 모니터 합친 영역)
  workWin.webContents.on('did-finish-load', () => {
    workWin.webContents.send('screen-bounds', getCombinedDesktopBounds());
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
    if (app.isQuitting) return;
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
  // 트레이 아이콘 (파일 우선, 없으면 기본 폴백)
  const iconPath = path.join(__dirname, 'tray-icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error('icon empty');
  } catch (e) {
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVQ4T2P8z8BQz0BAwMCIBDCKGBhYGP4zMDIwICsAMRgYGP4zMDAwoOuBmUL/GQBR3REREfXJYQAAAABJRU5ErkJggg=='
    );
  }
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: `FitCharacter v${CURRENT_VERSION}`, enabled: false },
    { type: 'separator' },
    {
      label: '일하는 중',
      type: 'radio',
      click: () => switchMode('work'),
    },
    {
      label: '휴식 중',
      type: 'radio',
      checked: true,
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

  tray.setToolTip(`Fit Character v${CURRENT_VERSION}`);
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
  let fileName;
  if (g === 'girl') fileName = 'pixelated-cartoon-girl.svg';
  else if (g === 'pikachu') fileName = 'pixelated-cartoon-pikachu.svg';
  else if (g === 'psyduck') fileName = 'pixelated-cartoon-psyduck.svg';
  else fileName = 'pixelated-cartoon-boy.svg';
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

// 셋업 완료 → Rest 모드로
ipcMain.on('setup-done', () => {
  if (setupWin) {
    setupWin.close();
    setupWin = null;
  }
  currentMode = 'rest';
  createRestWindow();
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
    if (app.isQuitting) return;
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
app.whenReady().then(async () => {
  createTray();

  // 1) 이전 업데이트 결과 안내 (성공/실패/중단)
  await handlePreviousUpdateResult();

  // 2) 새 업데이트 확인 및 진행 (업데이트 시 앱 종료되므로 창 생성 생략)
  const updating = await checkForUpdate();
  if (updating) return;

  // 3) 정상 실행 (rest 모드로 진입)
  if (hasProfile()) {
    currentMode = 'rest';
    createRestWindow();
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
