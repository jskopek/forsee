// Sets the release version of the desktop app and the web app it carries.
// Usage: pnpm release:version 0.2.1
import { readFileSync, writeFileSync } from 'node:fs';
import { URL } from 'node:url';

const version = process.argv[2];
if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: pnpm release:version <major.minor.patch>');
  process.exit(2);
}
for (const file of ['apps/desktop/package.json', 'apps/web/package.json']) {
  const url = new URL(`../../../${file}`, import.meta.url);
  const text = readFileSync(url, 'utf8');
  writeFileSync(url, text.replace(/("version": )"[^"]*"/, `$1"${version}"`));
  console.log(`${file}: ${version}`);
}
