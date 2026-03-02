import { readFileSync, writeFileSync } from 'fs';
const { version } = JSON.parse(readFileSync('./package.json', 'utf8'));
writeFileSync('./src/lib/version.js', `export const version = '${version}';\n`);
console.log(`version.js → ${version}`);
