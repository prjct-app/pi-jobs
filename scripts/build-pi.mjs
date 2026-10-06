#!/usr/bin/env node
/**
 * Builds a compiled local Pi package so Pi loads JavaScript instead of
 * transpiling this repository's TypeScript sources on start.
 *
 *   node scripts/build-pi.mjs [packageRoot] [--out dir]
 *
 * The default output is <agent dir>/builds/<package name>, outside the
 * repository on purpose: compiled code inside the repository resolves
 * @earendil-works/* from the repository's devDependencies and loads a second
 * copy of Pi (~500ms, separate module instances) instead of the host's.
 *
 * Configuration lives in package.json under "piBuild":
 *   entries   source files to compile; the first is the extension entry
 *   copy      files or directories copied as-is (assets, themes, prompts)
 *   external  runtime packages left to node_modules (native ones); the build
 *             links only these, never the host packages
 *   standalone entries that run as their own Node process instead of inside
 *             Pi (daemons, CLIs); Pi's packages are linked beside them, in a
 *             subdirectory the extension entry cannot resolve from
 *
 * Pi's host APIs (@earendil-works/*, typebox) are always external: Pi provides
 * its own instances to extensions. Everything else is bundled.
 */
import { build } from 'esbuild';
import { cp, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const out = outFlag >= 0 ? args.splice(outFlag, 2)[1] : undefined;
const root = args[0] ? resolve(args[0]) : join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const config = { entries: ['index.ts'], copy: [], external: [], standalone: [], ...manifest.piBuild };
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
const target = out ? resolve(out) : join(agentDir, 'builds', manifest.name.replace(/^@[^/]+\//, ''));

const HOST = [
  '@earendil-works/*', '@mariozechner/*',
  'typebox', 'typebox/*', '@sinclair/typebox', '@sinclair/typebox/*',
];

const toJs = path => path.replace(/\.[cm]?ts$/, '.js');

/**
 * A bundle has one import.meta.url. Each source module's import.meta.url is
 * rewritten to where that module sits in the build's mirror of the source
 * tree, so relative asset and entry paths resolve inside the build.
 */
const moduleUrls = {
  name: 'module-urls',
  setup(builder) {
    builder.onLoad({ filter: /\.[cm]?ts$/ }, async args => {
      if (!args.path.startsWith(root + sep) || args.path.includes(`${sep}node_modules${sep}`)) return undefined;
      const source = await readFile(args.path, 'utf8');
      if (!source.includes('import.meta.url')) return undefined;
      const mirror = toJs(relative(root, args.path)).split(sep).join('/');
      return {
        contents: source.replaceAll('import.meta.url', `new URL(${JSON.stringify(mirror)}, __piBuildRoot).href`),
        loader: 'ts',
      };
    });
  },
};

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: [...HOST, ...config.external],
  plugins: [moduleUrls],
  keepNames: true,
  legalComments: 'none',
  logLevel: 'warning',
};

// Bundled CommonJS dependencies call require() for Node built-ins (for example
// child_process); ESM output has no require unless the banner provides one.
const rootFor = output => {
  const depth = output.split('/').length - 1;
  return [
    "import { createRequire as __piCreateRequire } from 'node:module';",
    'const require = __piCreateRequire(import.meta.url);',
    `const __piBuildRoot = new URL(${JSON.stringify(depth ? '../'.repeat(depth) : './')}, import.meta.url);`,
  ].join('\n');
};

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

const [main, ...others] = config.entries;
// The extension entry keeps dynamic imports lazy through code splitting; chunks
// sit next to it so the same build-root banner applies to every file.
await build({
  ...common,
  entryPoints: [join(root, main)],
  outdir: target,
  entryNames: toJs(main).replace(/\.js$/, ''),
  chunkNames: 'chunk-[hash]',
  splitting: true,
  banner: { js: rootFor(toJs(main)) },
});
for (const entry of others) {
  const output = toJs(entry);
  await build({ ...common, entryPoints: [join(root, entry)], outfile: join(target, output), banner: { js: rootFor(output) } });
}

for (const item of config.copy) {
  await cp(join(root, item), join(target, item), { recursive: true });
}

// Only the declared runtime externals are reachable; they link to this
// repository's installed copies, whose own dependencies resolve from there.
for (const name of config.external) {
  const link = join(target, 'node_modules', name);
  await mkdir(dirname(link), { recursive: true });
  await symlink(await realpath(join(root, 'node_modules', name)), link, 'dir');
}

// A standalone process has no host to provide Pi's modules. Link the versions
// this repository develops against, next to the entry and never at the build
// root, where the extension would pick them up instead of the host's.
const hostPackages = async () => {
  const scoped = await readdir(join(root, 'node_modules', '@earendil-works')).catch(() => []);
  const names = [...scoped.map(name => `@earendil-works/${name}`), 'typebox'];
  const present = await Promise.all(names.map(async name => (await realpath(join(root, 'node_modules', name)).catch(() => undefined)) && name));
  return present.filter(Boolean);
};
for (const entry of config.standalone) {
  const directory = dirname(join(target, toJs(entry)));
  if (directory === target) throw new Error(`Standalone entry ${entry} must live in a subdirectory, not beside the extension entry.`);
  for (const name of await hostPackages()) {
    const link = join(directory, 'node_modules', name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(await realpath(join(root, 'node_modules', name)), link, 'dir');
  }
}

const pi = { ...manifest.pi, extensions: [`./${toJs(main)}`] };
delete pi.image;
delete pi.video;
await writeFile(join(target, 'package.json'), `${JSON.stringify({
  name: manifest.name, version: manifest.version, private: true, type: 'module',
  description: `Compiled local build of ${manifest.name} from ${root}. Generated by scripts/build-pi.mjs; do not edit.`,
  pi,
}, null, 2)}\n`);

console.log(`${manifest.name} built into ${target}: ${config.entries.map(toJs).join(', ')}${config.copy.length ? ` + ${config.copy.join(', ')}` : ''}`);
