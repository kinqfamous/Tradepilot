import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const outputDirectory = fileURLToPath(new URL('./dist/', import.meta.url));

// Remove only this project's generated output. Resolving from import.meta.url
// keeps the target safe even if the build command is launched from elsewhere.
await rm(outputDirectory, { recursive: true, force: true });

await build({
  absWorkingDir: projectRoot,
  entryPoints: {
    index: 'src/index.ts',
    worker: 'src/queues/worker.ts',
  },
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outdir: outputDirectory,
  outExtension: { '.js': '.mjs' },
  entryNames: '[name]',
  sourcemap: true,
  sourcesContent: false,
  legalComments: 'none',
  treeShaking: true,
  logLevel: 'info',
});
