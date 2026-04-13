// 릴리즈 스크립트: npm run release -- 1.1.0
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const newVersion = process.argv[2];
if (!newVersion) {
  console.error('사용법: npm run release -- <버전>\n예시: npm run release -- 1.1.0');
  process.exit(1);
}

const mainPath = path.join(__dirname, 'main.js');
const versionPath = path.join(__dirname, 'version.json');
const pkgPath = path.join(__dirname, 'package.json');

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: __dirname });
}

console.log(`\n=== FitCharacter v${newVersion} 릴리즈 시작 ===\n`);

// 1. main.js CURRENT_VERSION 업데이트
console.log('1. main.js 버전 업데이트...');
let mainContent = fs.readFileSync(mainPath, 'utf-8');
mainContent = mainContent.replace(/const CURRENT_VERSION = '.*?'/, `const CURRENT_VERSION = '${newVersion}'`);
fs.writeFileSync(mainPath, mainContent, 'utf-8');

// 2. package.json 버전 업데이트
console.log('2. package.json 버전 업데이트...');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');

// 3. 빌드
console.log('3. Electron 빌드...');
run('npx electron-builder --win --dir');

// 4. ZIP 압축
console.log('4. ZIP 압축...');
const zipPath = path.join(__dirname, 'dist', 'FitCharacter.zip');
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
run(`powershell -Command "Compress-Archive -Path 'dist\\win-unpacked\\*' -DestinationPath 'dist\\FitCharacter.zip' -Force"`);

// 5. 커밋 & 푸시 (version.json 제외 — ZIP 업로드 후에 올림)
console.log('5. 커밋 & 푸시...');
run('git add main.js package.json');
run(`git commit -m "v${newVersion} 릴리즈 준비"`);
run('git push');

// 6. GitHub Release 생성 + ZIP 업로드
console.log('6. GitHub Release 생성...');
try { run(`gh release delete v${newVersion} --yes`); } catch(e) {}
run(`gh release create v${newVersion} dist/FitCharacter.zip --title "v${newVersion}" --notes "FitCharacter v${newVersion} 릴리즈"`);

// 7. version.json 업데이트 (마지막에! — 이때부터 기존 사용자에게 알림)
console.log('7. version.json 업데이트 (알림 활성화)...');
const versionJson = {
  version: newVersion,
  downloadUrl: 'https://github.com/kimkichan1225/company-app/releases/latest/download/FitCharacter.zip'
};
fs.writeFileSync(versionPath, JSON.stringify(versionJson, null, 2) + '\n', 'utf-8');
run('git add version.json');
run(`git commit -m "v${newVersion} 업데이트 알림 활성화"`);
run('git push');

console.log(`\n=== v${newVersion} 릴리즈 완료! ===`);
console.log('기존 사용자들이 앱 실행 시 자동 업데이트 알림을 받습니다.\n');
