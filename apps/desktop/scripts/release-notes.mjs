// Prints the CHANGELOG.md entry for a version, or fails if there is none.
// Usage: node apps/desktop/scripts/release-notes.mjs [version]
//   (default: the version in apps/desktop/package.json)
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const root = new URL('../../../', import.meta.url);
const version =
  process.argv[2] ??
  JSON.parse(readFileSync(new URL('apps/desktop/package.json', root), 'utf8')).version;

const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8');
const lines = changelog.split('\n');
const start = lines.findIndex((line) =>
  new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b`).test(line),
);
const fail = (message) => {
  console.error(
    `${message}\nAdd a "## ${version}" section to CHANGELOG.md describing what changed.`,
  );
  process.exit(1);
};
if (start === -1) fail(`CHANGELOG.md has no entry for ${version}.`);

const rest = lines.slice(start + 1);
const end = rest.findIndex((line) => line.startsWith('## '));
const notes = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
if (notes === '') fail(`The CHANGELOG.md entry for ${version} is empty.`);
if (/\bTODO\b/.test(notes)) fail(`The CHANGELOG.md entry for ${version} still says TODO.`);

console.log(notes);
