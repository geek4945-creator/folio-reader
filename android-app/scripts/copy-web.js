// Copies the PWA files from the repo root into ./www (the Capacitor webDir).
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..', '..'), out = path.resolve(__dirname, '..', 'www');
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'config.js', 'sw.js', 'manifest.webmanifest', 'css', 'js', 'vendor', 'icons'])
  fs.cpSync(path.join(root, f), path.join(out, f), { recursive: true });
console.log('copied web files to', out);
