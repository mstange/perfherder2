// Refuse to publish a bundle that is not the version on the tin.
//
// `perfherder-cli/dist/` is gitignored and the only thing that rebuilds it is
// the wrapper, when someone happens to run it. So the easy mistake here is
// bumping the version, publishing, and shipping last week's code under this
// week's number — which is worse than shipping nothing, because the version is
// what a bug report will quote.
//
// The check is a string search rather than a timestamp comparison: the version
// is compiled *into* the bundle (vite.cli.config.ts's `define`), so its presence
// is evidence about the artifact itself and not about the filesystem's opinion
// of when things happened.
//
// Wired to `prepublishOnly`, so it runs whichever way `npm publish` is invoked.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkgUrl = new URL('../perfherder-cli/package.json', import.meta.url);
const bundleUrl = new URL('../perfherder-cli/dist/perfherder-cli.mjs', import.meta.url);
const bundlePath = fileURLToPath(bundleUrl);

if (!existsSync(bundleUrl)) {
  console.error(
    `perfherder-cli bundle not found at ${bundlePath}.\n` +
      `Run 'npm run build:cli' from the repository root before publishing.`,
  );
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(pkgUrl, 'utf8'));
const bundle = readFileSync(bundleUrl, 'utf8');

if (!bundle.includes(JSON.stringify(version))) {
  console.error(
    `perfherder-cli bundle does not carry the version in package.json (${version}), so it is\n` +
      `stale. Rebuild it with 'npm run build:cli' from the repository root.`,
  );
  process.exit(1);
}

// The shebang and the executable bit are what make `perfherder-cli` a command
// rather than a file. npm sets the bit when it installs a `bin`, but a tarball
// unpacked by hand does not get that favour, and a missing shebang is not
// something npm can fix at all.
if (!bundle.startsWith('#!/usr/bin/env node')) {
  console.error('perfherder-cli bundle has no shebang — check the banner in vite.cli.config.ts.');
  process.exit(1);
}
if ((statSync(bundleUrl).mode & 0o111) === 0) {
  console.error('perfherder-cli bundle is not executable — check the chmod plugin in vite.cli.config.ts.');
  process.exit(1);
}

console.log(`perfherder-cli build verified (version ${version})`);
