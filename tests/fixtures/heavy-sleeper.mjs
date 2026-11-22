import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], 'ready');
setTimeout(() => {}, 1200);
