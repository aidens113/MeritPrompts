import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Arguments remain data; known Windows package-manager shims resolve to Node. */
export function childCommand(argv, platform = process.platform) {
  if (platform !== 'win32') return { file: argv[0], args: argv.slice(1) };
  const words = [...argv];
  if (words[0] === 'bash' && existsSync('C:/Program Files/Git/bin/bash.exe')) words[0] = 'C:/Program Files/Git/bin/bash.exe';
  const manager = /^(?:npm|pnpm|npx)(?:\.cmd)?$/i.test(path.basename(words[0]));
  if (manager) {
    const named = /\.cmd$/i.test(words[0]) ? words[0] : `${words[0]}.cmd`;
    const shim = path.isAbsolute(named) ? named : execFileSync('where.exe', [named], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0];
    const targets = [...readFileSync(shim, 'utf8').matchAll(/%(?:dp0%|~dp0)[\\/](node_modules[\\/][^"\r\n]+?\.(?:cjs|mjs|js))/gi)].map((match) => path.resolve(path.dirname(shim), match[1]));
    const managerName = path.basename(words[0]).replace(/\.cmd$/i, '').toLowerCase();
    const localNode = path.join(path.dirname(shim), 'node.exe');
    const node = existsSync(localNode) ? localNode : process.execPath;
    let entries = [...new Set(targets)].filter(existsSync);
    if (managerName === 'npm' || managerName === 'npx') {
      const prefixEntry = entries.find((entry) => path.basename(entry) === 'npm-prefix.js');
      const cliName = `${managerName}-cli.js`;
      entries = entries.filter((entry) => path.basename(entry) === cliName);
      if (prefixEntry) {
        // Match npm's installed shim: the configured prefix may supply its CLI.
        const prefix = execFileSync(node, [prefixEntry], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const redirected = path.join(prefix, 'node_modules', 'npm', 'bin', cliName);
        if (prefix && existsSync(redirected)) entries = [redirected];
      }
    }
    if (entries.length !== 1) throw new Error('Cannot resolve this package-manager shim to one native Node entry; invoke its Node entry explicitly.');
    return { file: node, args: [entries[0], ...words.slice(1)] };
  }
  if (!/\.(?:cmd|bat)$/i.test(words[0])) return { file: words[0], args: words.slice(1) };
  // Windows PowerShell's batch forwarding loses empty arguments and reparses
  // shell syntax. Only known shims above have a proven native entry.
  throw new Error('Batch commands require an explicit native executable entry for lossless execution.');
}
