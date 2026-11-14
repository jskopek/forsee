// Sets the release version of the desktop app and the web app it carries.
// Also adds an empty CHANGELOG.md entry to fill in.
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

const changelogUrl = new URL('../../../CHANGELOG.md', import.meta.url);
const changelog = readFileSync(changelogUrl, 'utf8');
if (!new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b`, 'm').test(changelog)) {
  const firstEntry = changelog.search(/^## /m);
  const entry = `## ${version}\n\n- TODO: what changed, for the people who use Forsee.\n\n`;
  const updated =
    firstEntry === -1
      ? `${changelog.trimEnd()}\n\n${entry}`
      : changelog.slice(0, firstEntry) + entry + changelog.slice(firstEntry);
  writeFileSync(changelogUrl, updated);
  console.log(`CHANGELOG.md: added a ${version} entry to fill in`);
}
