'use strict';
// Copies the on-phone receipt reader (Tesseract.js and its English language file) and the QR code maker used by
// "Link my devices" into public/ocr, so the site serves them itself.
// Netlify runs this as the build command. When self-hosting, run `npm install` then `node scripts/copy-ocr.js` once.
const fs = require('node:fs');
const path = require('node:path');

const out = path.join(__dirname, '..', 'public', 'ocr');
const dirOf = (pkg, from) => path.dirname(require.resolve(pkg + '/package.json', from ? { paths: [from] } : undefined));
const tess = dirOf('tesseract.js');
const core = dirOf('tesseract.js-core', tess);
const lang = dirOf('@tesseract.js-data/eng');

fs.mkdirSync(out, { recursive: true });
const copy = (from) => fs.copyFileSync(from, path.join(out, path.basename(from)));
copy(path.join(tess, 'dist', 'tesseract.min.js'));
copy(path.join(tess, 'dist', 'worker.min.js'));
// The LSTM-only builds, one per WebAssembly feature level; the worker picks the one the phone supports.
for (const f of fs.readdirSync(core)) if (/-lstm\.wasm\.js$/.test(f)) copy(path.join(core, f));
copy(path.join(lang, '4.0.0_best_int', 'eng.traineddata.gz'));
copy(path.join(dirOf('qrcode-generator'), 'qrcode.js'));
console.log('Receipt reader and QR maker copied to public/ocr:', fs.readdirSync(out).join(', '));
