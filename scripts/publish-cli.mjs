// Publish perfherder-cli: the four gates, then a fresh build, then npm.
//
// The gates are the ones CI runs and CLAUDE.md asks for before a commit. They
// are here rather than assumed because publishing is the one action in this
// repository that cannot be undone by editing a file: an npm version number is
// spent the moment it is used.
//
// The rebuild is not belt-and-braces either. The bundle is gitignored and only
// the wrapper rebuilds it, so the version compiled into whatever is on disk is
// whatever it was the last time somebody ran the tool. `prepublishOnly` catches
// that too (verify-cli-build.mjs), but catching it here means the publish
// succeeds rather than aborting halfway.
//
// A prerelease version goes to the `next` dist-tag rather than `latest`, so
// `npm install -g @mstange/perfherder-cli` never lands a reader on one by
// accident. Pass `--tag` yourself to override.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkgUrl = new URL('../perfherder-cli/package.json', import.meta.url);
const { name, version } = JSON.parse(readFileSync(pkgUrl, 'utf8'));

const forwarded = process.argv.slice(2);
const taggedByHand = forwarded.some((arg) => arg === '--tag' || arg.startsWith('--tag='));
const tag = taggedByHand ? [] : ['--tag', version.includes('-') ? 'next' : 'latest'];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Publishing ${name}@${version}\n`);
run('npm', ['run', 'check']);
run('npm', ['test']);
run('npm', ['run', 'build']);
run('npm', ['run', 'build:cli']);
run('npm', ['publish', 'perfherder-cli/', ...tag, ...forwarded]);
