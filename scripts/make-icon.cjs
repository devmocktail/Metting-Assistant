// Renders the app's "A2" brand mark (as in the top bar) to build-resources/icon.png,
// which electron-builder turns into the Windows icon.
//   node node_modules/electron/cli.js scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const html = `<!doctype html><html><body style="margin:0;background:transparent">
<div style="display:grid;width:256px;height:256px;place-items:center;border-radius:72px;background:#50dea3;
color:#0c1913;font:800 104px 'Segoe UI',Arial,sans-serif;letter-spacing:-4px">A2</div></body></html>`;

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true } });
  win.webContents.once('did-finish-load', () => setTimeout(async () => {  // after the first real frame
    const image = await win.webContents.capturePage();
    const out = path.join(__dirname, '..', 'build-resources', 'icon.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, image.resize({ width: 256, height: 256 }).toPNG());
    console.log(`Wrote ${out}`);
    app.quit();
  }, 500));
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
});
