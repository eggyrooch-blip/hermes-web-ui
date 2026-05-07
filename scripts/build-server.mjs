import * as esbuild from 'esbuild'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf-8'))
const version = pkg.version

await esbuild.build({
  entryPoints: [resolve(rootDir, 'packages/server/src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node23',
  format: 'cjs',
  outfile: resolve(rootDir, 'dist/server/index.js'),
  external: ['node-pty', 'node:sqlite', 'socket.io'],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  // Sourcemaps shipped to production reveal full server logic. Keep them only
  // for local dev / CI where NODE_ENV is not 'production'.
  sourcemap: process.env.NODE_ENV !== 'production',
  minify: true,
  treeShaking: true,
  logLevel: 'info',
})
