// After the Windows installer is signed (which changes its bytes), rewrite
// the updater's metadata so its size and SHA-512 match the signed file, and
// rebuild the block map used for smaller "differential" downloads.
//
// Usage: node scripts/refresh-update-info.mjs release/Forsee-Setup.exe release/latest.yml
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const [installer, latestYml] = process.argv.slice(2);
if (installer === undefined || latestYml === undefined) {
  console.error('Usage: refresh-update-info.mjs <installer.exe> <latest.yml>');
  process.exit(2);
}

const fromBuilder = createRequire(createRequire(import.meta.url).resolve('electron-builder'));
const blockmapModule = path.join(
  path.dirname(fromBuilder.resolve('app-builder-lib/package.json')),
  'out/targets/blockmap/blockmap.js',
);
const { buildBlockMap } = createRequire(import.meta.url)(blockmapModule);

const info = await buildBlockMap(installer, 'gzip', `${installer}.blockmap`);
const name = path.basename(installer);

let yml = readFileSync(latestYml, 'utf8');
const before = yml;
// The file entry: "- url: <name>\n    sha512: ...\n    size: ..."
yml = yml.replace(
  new RegExp(
    `(url: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\s+sha512: )\\S+(\\n\\s+size: )\\d+`,
  ),
  `$1${info.sha512}$2${info.size}`,
);
// The top-level copy of the hash.
yml = yml.replace(/^sha512: \S+$/m, `sha512: ${info.sha512}`);
if (yml === before) {
  console.error(`Could not find ${name} in ${latestYml}:\n${before}`);
  process.exit(1);
}
writeFileSync(latestYml, yml);
console.log(`Updated ${latestYml} for the signed ${name} (${info.size} bytes).`);
