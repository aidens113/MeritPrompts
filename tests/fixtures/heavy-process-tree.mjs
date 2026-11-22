import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const [root, mode] = process.argv.slice(2);
if (mode === 'leaf') {
  writeFileSync(path.join(root, 'leaf.pid'), String(process.pid));
  const timer = setInterval(() => {
    if (existsSync(path.join(root, 'finish-leaf'))) { clearInterval(timer); process.exit(0); }
  }, 20);
} else {
  const leaf = spawn(process.execPath, [fileURLToPath(import.meta.url), root, 'leaf'], { stdio: 'ignore', windowsHide: true, detached: true });
  leaf.unref();
  while (!existsSync(path.join(root, 'leaf.pid'))) await new Promise((resolve) => setTimeout(resolve, 10));
  writeFileSync(path.join(root, 'parent.pid'), String(process.pid));
  if (mode === 'orphan') process.exit(0);
  else setInterval(() => {}, 1000);
}
