'use strict';
// Obfuscates every app JS file from src/ into build/obf/src for packaging.
// Non-JS files (html, css, wav, etc.) are copied verbatim so the in-asar layout
// and all relative paths (../node_modules, styles.css, preload.js) stay identical.
// electron-builder then packages build/obf/src -> src inside app.asar, so the
// shipped code is scrambled and string-encrypted, not your readable source.
const fs = require('node:fs');
const path = require('node:path');
const JO = require('javascript-obfuscator');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'build', 'obf', 'src');

// Strong but eval-free (the renderer CSP forbids eval), so it runs in both the
// Node main/preload context and the sandboxed browser renderer.
const OPTS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.6,
  deadCodeInjection: false,
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: true,
  simplify: true,
  stringArray: true,
  // Index-scrambling transforms (rotate/shuffle/calls-transform) mis-resolved some
  // string-array entries in the packaged build — clipboard.writeImage came back "not
  // a function", so the screen capture → ChatGPT paste threw. Disabling them keeps
  // strings base64-encoded in the array (still obfuscated) but makes every lookup
  // resolve correctly. Control-flow flattening + identifier renaming stay on.
  stringArrayCallsTransform: false,
  stringArrayRotate: false,
  stringArrayShuffle: false,
  stringArrayIndexShift: false,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.85,
  splitStrings: true,
  splitStringsChunkLength: 10,
  transformObjectKeys: true,
  selfDefending: false, // can conflict with Electron/minifiers; off on purpose
  unicodeEscapeSequence: false,
  target: 'browser',
};

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }

rmrf(path.join(ROOT, 'build', 'obf'));
let files = 0, jsBytes = 0;

(function walk(rel) {
  const absDir = path.join(SRC, rel);
  for (const name of fs.readdirSync(absDir)) {
    const r = rel ? path.join(rel, name) : name;
    const a = path.join(SRC, r);
    const o = path.join(OUT, r);
    const st = fs.statSync(a);
    if (st.isDirectory()) { fs.mkdirSync(o, { recursive: true }); walk(r); continue; }
    fs.mkdirSync(path.dirname(o), { recursive: true });
    if (name.endsWith('.js')) {
      const code = fs.readFileSync(a, 'utf8');
      const out = JO.obfuscate(code, OPTS).getObfuscatedCode();
      fs.writeFileSync(o, out);
      files++; jsBytes += out.length;
    } else {
      fs.copyFileSync(a, o);
    }
  }
})('');

console.log(`Obfuscated ${files} JS file(s) -> build/obf/src (${(jsBytes / 1024).toFixed(0)} KB)`);
