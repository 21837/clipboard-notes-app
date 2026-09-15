const fs = require('fs');
const path = require('path');

const { createCanvas } = require('canvas');

// 生成应用图标：256x256 PNG。
// electron-builder 会据此自动生成 Windows 的 .ico ——
// ⚠️ 不要把 PNG 字节直接写进 .ico 文件（格式不同，打包会报 "image: unknown format"）。
// Windows 图标最小要求 256x256（原脚本只生成 64x64，不达标）。
const size = 256;
const canvas = createCanvas(size, size);
const ctx = canvas.getContext('2d');

ctx.fillStyle = '#6366f1';
ctx.beginPath();
ctx.roundRect(8, 8, size - 16, size - 16, 32);
ctx.fill();

ctx.fillStyle = '#ffffff';
ctx.font = 'bold 140px Arial';
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.fillText('N', size / 2, size / 2 + 6);

const buffer = canvas.toBuffer('image/png');
fs.writeFileSync(path.join(__dirname, 'assets', 'icon.png'), buffer);
fs.writeFileSync(path.join(__dirname, 'icon.png'), buffer);

console.log('图标生成完成：assets/icon.png + icon.png (256x256 PNG)');
