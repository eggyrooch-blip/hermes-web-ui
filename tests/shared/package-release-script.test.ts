import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
const script = join(repoRoot, 'scripts', 'package-release.sh')

// A real commit id's shape matters to the script: the artifact is published under
// this string as its package VERSION, and the deployer resolves it by sha.
const SHA = '0e3ad1b3311f4c0a9b7d2e6f8a1c4d5e60718293'

const fixtures: string[] = []

afterEach(() => {
  while (fixtures.length > 0) {
    const dir = fixtures.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A minimal project the script can package: a dist/ with the server bundle it
 * insists on, a node-pty native module carrying ELF magic (so the glibc gate
 * engages instead of taking its non-Linux escape hatch), and a stub `objdump`
 * that reports whatever symbol version the case is about.
 */
function makeFixture(glibcSymbol: string): { root: string; stubBin: string } {
  const root = mkdtempSync(join(tmpdir(), 'webui-package-'))
  fixtures.push(root)

  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3 }))

  mkdirSync(join(root, 'dist', 'server'), { recursive: true })
  writeFileSync(join(root, 'dist', 'server', 'index.js'), '// bundle\n')
  mkdirSync(join(root, 'dist', 'client'), { recursive: true })
  writeFileSync(join(root, 'dist', 'client', 'index.html'), '<!doctype html>\n')

  const ptyDir = join(root, 'node_modules', 'node-pty', 'build', 'Release')
  mkdirSync(ptyDir, { recursive: true })
  // 0x7f 'E' 'L' 'F' then filler: the script reads the magic rather than shelling
  // out to file(1), so four bytes are all that separates "Linux object" from
  // "someone's laptop build".
  writeFileSync(join(ptyDir, 'pty.node'), Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.alloc(64),
  ]))

  const stubBin = join(root, 'stub-bin')
  mkdirSync(stubBin)
  const objdump = join(stubBin, 'objdump')
  writeFileSync(
    objdump,
    `#!/bin/sh\necho "0000 g DF .text 0000 ${glibcSymbol} forkpty"\necho "0000 w D *UND* 0000 GLIBC_PRIVATE __foo"\n`,
  )
  chmodSync(objdump, 0o755)

  return { root, stubBin }
}

interface PublishFixture {
  root: string
  stubBin: string
  curlLog: string
  localSidecar: string
}

/**
 * Publish mode refuses --skip-build and --reuse-node-modules and demands a Linux
 * builder, so a publish test cannot take any of the shortcuts the packaging
 * tests use. It stubs the three programs the script shells out to instead — npm,
 * uname and curl — which keeps the run offline and deterministic while the
 * script itself executes its real publish path end to end.
 */
function makePublishFixture(): PublishFixture {
  const root = mkdtempSync(join(tmpdir(), 'webui-publish-'))
  fixtures.push(root)

  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3 }))

  const stubBin = join(root, 'stub-bin')
  mkdirSync(stubBin)
  const stub = (name: string, body: string) => {
    const file = join(stubBin, name)
    writeFileSync(file, body)
    chmodSync(file, 0o755)
  }

  stub('objdump', '#!/bin/sh\necho "0000 g DF .text 0000 GLIBC_2.28 forkpty"\n')
  stub('uname', '#!/bin/sh\necho Linux\n')
  // `npm ci` materialises an ELF node-pty wherever it is run (the project root
  // first, then the staging dir); `npm run build` materialises dist/.
  stub('npm', [
    '#!/bin/sh',
    // Every invocation is logged so a test can pin the install flags and the
    // ci -> rebuild -> build order: package.json's `prepare` hook is
    // `[ -d dist ] || npm run build`, so dropping --ignore-scripts silently
    // builds twice and blows the job timeout (job 3249648, 2026-09-21).
    '[ -n "$NPM_LOG" ] && printf \'%s\\n\' "$*" >> "$NPM_LOG"',
    'case "$1" in',
    '  ci)',
    '    mkdir -p node_modules/node-pty/build/Release',
    "    printf '\\177ELF' > node_modules/node-pty/build/Release/pty.node",
    '    head -c 64 /dev/zero >> node_modules/node-pty/build/Release/pty.node',
    '    ;;',
    '  run)',
    '    mkdir -p dist/server dist/client',
    "    echo '// bundle' > dist/server/index.js",
    "    echo '<!doctype html>' > dist/client/index.html",
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'))
  // Logs every invocation so a test can prove an upload did NOT happen. The
  // probe honours PROBE_CODE and, at 200, serves PROBE_BODY_FILE as the body.
  stub('curl', [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$CURL_LOG"',
    'case "$*" in',
    '  *--upload-file*) exit 0 ;;',
    'esac',
    // Exact-token scan, never a glob: `--header` contains the substring `--head`
    // and `--range` would collide just as easily, so `case "$*" in *--range*`
    // is not safe either.
    'out=""',
    'prev=""',
    'is_range=0',
    'for a in "$@"; do',
    '  if [ "$a" = "--range" ]; then is_range=1; fi',
    '  if [ "$prev" = "--output" ]; then out="$a"; fi',
    '  prev="$a"',
    'done',
    // The archive is probed with a ranged GET and answers on its own code, so a
    // test can put the registry in a half-written state.
    'if [ "$is_range" = "1" ]; then printf \'%s\' "$TAR_PROBE_CODE"; exit 0; fi',
    'if [ "$PROBE_CODE" = "200" ] && [ -n "$out" ]; then cat "$PROBE_BODY_FILE" > "$out"; fi',
    'printf \'%s\' "$PROBE_CODE"',
    'exit 0',
    '',
  ].join('\n'))

  return {
    root,
    stubBin,
    curlLog: join(root, 'curl.log'),
    localSidecar: join(root, '.release-artifact', `webui-${SHA}.sha256`),
  }
}

function runPublish(
  fx: PublishFixture,
  probe: { PROBE_CODE: string; TAR_PROBE_CODE?: string; PROBE_BODY_FILE?: string },
) {
  writeFileSync(fx.curlLog, '')
  return spawnSync('bash', [script], {
    cwd: fx.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fx.stubBin}:${process.env.PATH ?? ''}`,
      SHA,
      CI: '',
      CI_COMMIT_SHA: SHA,
      CI_JOB_TOKEN: 'job-token',
      CI_API_V4_URL: 'https://gitlab.example.invalid/api/v4',
      CI_PROJECT_ID: '2829',
      CI_JOB_IMAGE: 'docker.io/library/node:24-bullseye',
      CURL_LOG: fx.curlLog,
      PROBE_BODY_FILE: probe.PROBE_BODY_FILE ?? '/dev/null',
      PROBE_CODE: probe.PROBE_CODE,
      // Defaults to the sidecar's code, so the common "both present" and "both
      // absent" cases stay one setting.
      TAR_PROBE_CODE: probe.TAR_PROBE_CODE ?? probe.PROBE_CODE,
    },
  })
}

function run(root: string, stubBin: string, args: string[]) {
  return spawnSync('bash', [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${stubBin}:${process.env.PATH ?? ''}`,
      SHA,
      // The script refuses a non-ELF module when CI is set; these cases supply a
      // real ELF header, but keep the variable out so a CI run of this suite
      // behaves identically to a local one.
      CI: '',
      CI_COMMIT_SHA: '',
      CI_JOB_IMAGE: 'docker.io/library/node:24-bullseye',
    },
  })
}

describe('scripts/package-release.sh', () => {
  it('installs dev dependencies without running lifecycle scripts, then rebuilds node-pty before building', () => {
    // Publish mode is the only path that runs the dev install, the native
    // rebuild and the build for real, so it is the only place this order can
    // be observed end to end.
    const fx = makePublishFixture()
    const npmLog = join(fx.root, 'npm-invocations.log')
    writeFileSync(fx.curlLog, '')
    const result = spawnSync('bash', [script], {
      cwd: fx.root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fx.stubBin}:${process.env.PATH ?? ''}`,
        SHA,
        CI: '',
        CI_COMMIT_SHA: SHA,
        CI_JOB_TOKEN: 'job-token',
        CI_API_V4_URL: 'https://gitlab.example.invalid/api/v4',
        CI_PROJECT_ID: '2829',
        CI_JOB_IMAGE: 'docker.io/library/node:24-bullseye',
        CURL_LOG: fx.curlLog,
        PROBE_BODY_FILE: '/dev/null',
        PROBE_CODE: '404',
        NPM_LOG: npmLog,
      },
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)

    const calls = readFileSync(npmLog, 'utf8').trim().split('\n')
    const devInstall = calls.find(c => c.startsWith('ci ') && !c.includes('--omit=dev'))
    // Load-bearing, not hygiene: package.json's `prepare` is
    // `[ -d dist ] || npm run build`, so a dev install WITHOUT --ignore-scripts
    // builds inside npm ci and the explicit build then makes it twice. That
    // doubled work is what blew the 20m job timeout on the first real main
    // pipeline (job 3249648, 2026-09-21).
    expect(devInstall).toBeDefined()
    expect(devInstall).toContain('--ignore-scripts')

    // --ignore-scripts skips node-pty's node-gyp build, so it is rebuilt
    // explicitly, and before the bundle is produced.
    const iDev = calls.findIndex(c => c === devInstall)
    const iRebuild = calls.findIndex(c => c.startsWith('rebuild') && c.includes('node-pty'))
    const iBuild = calls.findIndex(c => c.startsWith('run build'))
    expect(iRebuild).toBeGreaterThan(iDev)
    expect(iBuild).toBeGreaterThan(iRebuild)

    // Exactly one build: the whole point of the fix.
    expect(calls.filter(c => c.startsWith('run build'))).toHaveLength(1)
  })

  it('packages a tarball and a sidecar whose hash matches the bytes on disk', () => {
    const { root, stubBin } = makeFixture('GLIBC_2.28')
    const result = run(root, stubBin, ['--dry-run', '--skip-build', '--reuse-node-modules'])

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)

    const tarball = join(root, '.release-artifact', `webui-${SHA}.tar.gz`)
    const sidecar = join(root, '.release-artifact', `webui-${SHA}.sha256`)
    expect(existsSync(tarball)).toBe(true)
    expect(existsSync(sidecar)).toBe(true)

    // The sidecar's exact shape is the contract the deployer parses: hex, two
    // spaces, the bare filename — not a path, so `sha256sum -c` works wherever
    // the file was downloaded to.
    const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex')
    expect(readFileSync(sidecar, 'utf8')).toBe(`${digest}  webui-${SHA}.tar.gz\n`)

    // Production has no zstd. The extension is not the contract — the bytes are,
    // so check the gzip magic (1f 8b) rather than trusting the filename.
    expect(readFileSync(tarball).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))

    const listing = spawnSync('tar', ['-tf', tarball], { encoding: 'utf8' })
    expect(listing.status, listing.stderr).toBe(0)
    const entries = listing.stdout.split('\n').map(line => line.replace(/^\.\//, ''))
    expect(entries).toContain('dist/server/index.js')
    expect(entries).toContain('node_modules/node-pty/build/Release/pty.node')
    expect(entries).toContain('package.json')
    expect(entries).toContain('package-lock.json')
    expect(entries).toContain('ARTIFACT.json')

    // Read ARTIFACT.json out of the archive, not the staging dir: staging is a
    // per-run mktemp directory that no longer exists by the time the script ends.
    const extracted = spawnSync('tar', ['-xOf', tarball, 'ARTIFACT.json'], { encoding: 'utf8' })
    expect(extracted.status, extracted.stderr).toBe(0)
    const manifest = JSON.parse(extracted.stdout)
    expect(manifest.sha).toBe(SHA)
    expect(manifest.glibc_max).toBe('2.28')
    expect(manifest.image).toBe('docker.io/library/node:24-bullseye')
    expect(manifest.built_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)

    // --dry-run means packaged, not published.
    expect(result.stdout).toContain('--dry-run: nothing published')
    expect(result.stdout).not.toContain('PUT ')
  })

  it('refuses to package when node-pty links a glibc above the production ceiling', () => {
    // bookworm builds 2.36; production (CentOS Stream 9) has 2.34 and the server
    // would die at require(). A tarball that cannot boot must never reach the
    // registry, so this is a hard failure, not a warning.
    const { root, stubBin } = makeFixture('GLIBC_2.36')
    const result = run(root, stubBin, ['--dry-run', '--skip-build', '--reuse-node-modules'])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('2.36')
    expect(result.stderr).toContain('2.34')
    expect(result.stderr).toMatch(/glibc ceiling exceeded/)
    expect(existsSync(join(root, '.release-artifact', `webui-${SHA}.tar.gz`))).toBe(false)
  })

  it('accepts a module sitting exactly on the ceiling', () => {
    const { root, stubBin } = makeFixture('GLIBC_2.34')
    const result = run(root, stubBin, ['--dry-run', '--skip-build', '--reuse-node-modules'])

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('GLIBC_2.34 <= ceiling 2.34')
  })

  it('produces the same gzip contract when pigz is on PATH', () => {
    // pigz is an optimisation, not a dependency: CI may or may not have it, and
    // the deployer must not be able to tell. Stub it so the parallel branch is
    // exercised on a machine that has never installed it.
    const { root, stubBin } = makeFixture('GLIBC_2.28')
    const pigz = join(stubBin, 'pigz')
    writeFileSync(pigz, '#!/bin/sh\nexec gzip "$@"\n')
    chmodSync(pigz, 0o755)

    const result = run(root, stubBin, ['--dry-run', '--skip-build', '--reuse-node-modules'])

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('compressing with pigz')

    const tarball = join(root, '.release-artifact', `webui-${SHA}.tar.gz`)
    expect(readFileSync(tarball).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))

    const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex')
    expect(readFileSync(join(root, '.release-artifact', `webui-${SHA}.sha256`), 'utf8'))
      .toBe(`${digest}  webui-${SHA}.tar.gz\n`)

    const listing = spawnSync('tar', ['-tf', tarball], { encoding: 'utf8' })
    expect(listing.status, listing.stderr).toBe(0)
    expect(listing.stdout).toContain('dist/server/index.js')
  })

  it('follows node-pty to a prebuild when there is no compiled build/Release', () => {
    // node-pty's lib/utils.js resolves build/Release, then build/Debug, then
    // prebuilds/<platform>-<arch>. Linux has no prebuild in the package today, so
    // CI compiles and lands in build/Release — but a hardcoded path would check a
    // file that does not exist the day upstream ships one, and pass by accident.
    const { root, stubBin } = makeFixture('GLIBC_2.36')
    const release = join(root, 'node_modules', 'node-pty', 'build', 'Release')
    const prebuilds = join(root, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`)
    mkdirSync(prebuilds, { recursive: true })
    // Move the over-ceiling module to where only the prebuild lookup finds it.
    writeFileSync(join(prebuilds, 'pty.node'), readFileSync(join(release, 'pty.node')))
    rmSync(join(root, 'node_modules', 'node-pty', 'build'), { recursive: true, force: true })

    const result = run(root, stubBin, ['--dry-run', '--skip-build', '--reuse-node-modules'])

    expect(result.stdout).toContain(`prebuilds/${process.platform}-${process.arch}/pty.node`)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/glibc ceiling exceeded/)
  })

  it('fails when no pty.node exists anywhere node-pty would look', () => {
    const { root, stubBin } = makeFixture('GLIBC_2.28')
    rmSync(join(root, 'node_modules', 'node-pty', 'build'), { recursive: true, force: true })

    const result = run(root, stubBin, ['--dry-run', '--skip-build', '--reuse-node-modules'])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('no pty.node under')
  })

  it('rejects a sha that is not a 40-hex commit id', () => {
    const { root, stubBin } = makeFixture('GLIBC_2.28')
    const result = spawnSync('bash', [script, '--dry-run', '--skip-build', '--reuse-node-modules'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${stubBin}:${process.env.PATH ?? ''}`, SHA: 'abc1234', CI: '', CI_COMMIT_SHA: '' },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('40-character lowercase hex')
  })

  it('will not publish without credentials instead of failing halfway through an upload', () => {
    const { root, stubBin } = makeFixture('GLIBC_2.28')
    const result = spawnSync('bash', [script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH ?? ''}`,
        SHA,
        CI: '',
        CI_COMMIT_SHA: '',
        CI_JOB_TOKEN: '',
        CI_API_V4_URL: '',
        CI_PROJECT_ID: '',
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('CI_JOB_TOKEN')
    // It must refuse BEFORE doing 10 minutes of work it would then throw away.
    expect(existsSync(join(root, '.release-artifact'))).toBe(false)
  })

  it('refuses the not-really-built flags in publish mode, before touching the disk', () => {
    // Publishing a --skip-build tree labels someone else's stale dist/ with this
    // commit's sha, and the deployer has no way to tell. Credentials are present
    // here precisely to prove the refusal is about the flags, not a missing token.
    for (const flag of ['--skip-build', '--reuse-node-modules']) {
      const { root, stubBin } = makeFixture('GLIBC_2.28')
      const result = spawnSync('bash', [script, flag], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${stubBin}:${process.env.PATH ?? ''}`,
          SHA,
          CI: '',
          CI_COMMIT_SHA: SHA,
          CI_JOB_TOKEN: 'token',
          CI_API_V4_URL: 'https://example.invalid/api/v4',
          CI_PROJECT_ID: '2829',
        },
      })

      expect(result.status, flag).not.toBe(0)
      expect(result.stderr, flag).toContain('allowed only with --dry-run')
      expect(existsSync(join(root, '.release-artifact')), flag).toBe(false)
    }
  })

  it('refuses to publish an artifact labelled with a commit other than the one being built', () => {
    const { root, stubBin } = makeFixture('GLIBC_2.28')
    const result = spawnSync('bash', [script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH ?? ''}`,
        SHA,
        CI: '',
        CI_COMMIT_SHA: 'f'.repeat(40),
        CI_JOB_TOKEN: 'token',
        CI_API_V4_URL: 'https://example.invalid/api/v4',
        CI_PROJECT_ID: '2829',
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('does not match CI_COMMIT_SHA')
  })

  it('leaves unrelated files in OUT_DIR alone', () => {
    // The old code ran `rm -rf "$OUT_DIR"`. OUT_DIR is whatever the caller passes,
    // so `OUT_DIR=..` deleted the repository. This run owns its own mktemp staging
    // dir and the two files it names, and nothing else.
    const { root, stubBin } = makeFixture('GLIBC_2.28')
    const outDir = join(root, 'shared-out')
    mkdirSync(outDir)
    const bystander = join(outDir, 'someone-elses-build.log')
    writeFileSync(bystander, 'do not delete me\n')
    mkdirSync(join(outDir, 'nested'))
    writeFileSync(join(outDir, 'nested', 'keep.txt'), 'also mine\n')

    const result = spawnSync('bash', [script, '--dry-run', '--skip-build', '--reuse-node-modules'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${stubBin}:${process.env.PATH ?? ''}`, SHA, CI: '', CI_COMMIT_SHA: '', OUT_DIR: outDir },
    })

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(readFileSync(bystander, 'utf8')).toBe('do not delete me\n')
    expect(readFileSync(join(outDir, 'nested', 'keep.txt'), 'utf8')).toBe('also mine\n')
    expect(existsSync(join(outDir, `webui-${SHA}.tar.gz`))).toBe(true)

    // The staging dir is the run's own and does not survive it.
    const leftovers = readdirSync(outDir).filter(name => name.startsWith('stage.'))
    expect(leftovers).toEqual([])
  })

  it('never pipes the archive listing into head', () => {
    // This one is a shape check on purpose. On Linux, GNU tar takes SIGPIPE when
    // head closes the pipe at line 20, pipefail propagates the 141, and set -e
    // ends the run after packaging and before publishing. macOS bsdtar exits 0
    // in exactly the same situation (measured: a 184KB listing into `head -1`
    // still returns 0), so the behaviour cannot be reproduced on this laptop and
    // the test below would pass against the bug. The shape is what is portable.
    const code = readFileSync(script, 'utf8')
      .split('\n')
      .filter(line => !/^\s*#/.test(line))
      .join('\n')
    expect(code).not.toMatch(/tar\s+-tf[^\n]*\|\s*head/)
  })

  it('reaches the publish step with a listing far larger than a pipe buffer', () => {
    // `tar -tf … | head -20` kills the script here: head closes the pipe, tar
    // takes SIGPIPE, pipefail and set -e end the run AFTER packaging and BEFORE
    // publishing. It only shows up once the listing outgrows the 64KB pipe
    // buffer, which a real 2000-entry artifact does and a toy fixture does not.
    const { root, stubBin } = makeFixture('GLIBC_2.28')
    const bulk = join(root, 'dist', 'client', 'assets')
    mkdirSync(bulk, { recursive: true })
    for (let i = 0; i < 3000; i++) {
      writeFileSync(join(bulk, `chunk-${String(i).padStart(6, '0')}-abcdefghijklmnop.js`), 'x')
    }

    const result = run(root, stubBin, ['--dry-run', '--skip-build', '--reuse-node-modules'])

    const tarball = join(root, '.release-artifact', `webui-${SHA}.tar.gz`)
    const listing = spawnSync('tar', ['-tf', tarball], { encoding: 'utf8' })
    expect(listing.stdout.length).toBeGreaterThan(64 * 1024)

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('--dry-run: nothing published')
  })

  it('publishes both files when the sha is not in the registry yet', () => {
    const fx = makePublishFixture()
    const result = runPublish(fx, { PROBE_CODE: '404' })

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain(`Published webui-release version ${SHA}`)

    // A 404 sidecar answers the question on its own: the archive is not probed.
    const calls = readFileSync(fx.curlLog, 'utf8').trim().split('\n')
    expect(calls).toHaveLength(3)
    expect(calls.filter(c => c.includes('--upload-file'))).toHaveLength(2)
    expect(calls.some(c => c.includes(' --range '))).toBe(false)
    expect(calls.some(c => c.includes(`webui-${SHA}.tar.gz`) && c.includes('--upload-file'))).toBe(true)
    expect(calls.some(c => c.includes(`webui-${SHA}.sha256`) && c.includes('--upload-file'))).toBe(true)
  })

  it('completes a version whose sidecar is published but whose archive is missing', () => {
    const fx = makePublishFixture()
    const result = runPublish(fx, { PROBE_CODE: '200', PROBE_BODY_FILE: fx.localSidecar, TAR_PROBE_CODE: '404' })

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('PARTIAL PUBLISH detected')
    expect(result.stdout).toContain(`Published webui-release version ${SHA}`)

    const calls = readFileSync(fx.curlLog, 'utf8').trim().split('\n')
    expect(calls.filter(c => c.includes('--upload-file'))).toHaveLength(2)
  })

  it('refuses a published sidecar that is not the contract shape', () => {
    // A truncated or HTML-error sidecar is not something to reason around: the
    // deployer verifies the archive against it, so a corrupt one is a broken
    // version that a human has to look at.
    for (const body of [
      'not a checksum at all\n',
      `${'a'.repeat(63)}  webui-${SHA}.tar.gz\n`,
      `${'a'.repeat(64)} webui-${SHA}.tar.gz\n`,
      `${'a'.repeat(64)}  webui-${'b'.repeat(40)}.tar.gz\n`,
      `${'a'.repeat(64)}  webui-${SHA}.tar.gz\nextra line\n`,
      '<html><body>404 Not Found</body></html>\n',
    ]) {
      const fx = makePublishFixture()
      const corrupt = join(fx.root, 'corrupt.sha256')
      writeFileSync(corrupt, body)
      const result = runPublish(fx, { PROBE_CODE: '200', PROBE_BODY_FILE: corrupt })

      expect(result.status, JSON.stringify(body)).not.toBe(0)
      expect(result.stderr, JSON.stringify(body)).toContain('is not \'<64hex>')
      expect(readFileSync(fx.curlLog, 'utf8'), JSON.stringify(body)).not.toContain('--upload-file')
    }
  })

  it('refuses to publish when the archive probe cannot be answered', () => {
    for (const code of ['500', '403', '000']) {
      const fx = makePublishFixture()
      const result = runPublish(fx, { PROBE_CODE: '200', PROBE_BODY_FILE: fx.localSidecar, TAR_PROBE_CODE: code })

      expect(result.status, code).not.toBe(0)
      expect(result.stderr, code).toContain('refusing to publish blind')
      expect(readFileSync(fx.curlLog, 'utf8'), code).not.toContain('--upload-file')
    }
  })

  it('skips when a complete package already exists for the sha', () => {
    // Re-running main's pipeline must not stack a second file under the same
    // name: GitLab accepts duplicate uploads by default and the deployer would
    // then have two candidates for one sha.
    for (const tarCode of ['200', '206']) {
      const fx = makePublishFixture()
      const result = runPublish(fx, { PROBE_CODE: '200', PROBE_BODY_FILE: fx.localSidecar, TAR_PROBE_CODE: tarCode })

      expect(result.status, `${tarCode}\n${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout, tarCode).toContain('already published (complete), skipping')

      const calls = readFileSync(fx.curlLog, 'utf8').trim().split('\n')
      expect(calls, tarCode).toHaveLength(2)
      expect(calls.some(c => c.includes('--upload-file')), tarCode).toBe(false)
    }
  })

  it('skips on a published sidecar whose hash differs from this run', () => {
    // Packaging is NOT reproducible: built_at is second-resolution and the staged
    // tree's mtimes are fresh, so two runs of one sha never agree byte for byte.
    // The identity of a release is the commit — same sha means same sources and
    // same lockfile — so a differing hash is expected and must not fail a retry.
    const fx = makePublishFixture()
    const other = join(fx.root, 'other.sha256')
    writeFileSync(other, `${'9'.repeat(64)}  webui-${SHA}.tar.gz\n`)

    const result = runPublish(fx, { PROBE_CODE: '200', PROBE_BODY_FILE: other, TAR_PROBE_CODE: '200' })

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('already published (complete), skipping')
    expect(readFileSync(fx.curlLog, 'utf8')).not.toContain('--upload-file')
  })

  it('refuses to publish when the registry probe cannot be answered', () => {
    // 401, 403, 5xx or a curl-level failure all mean the registry's state is
    // unknown. Uploading anyway is publishing blind.
    for (const code of ['500', '401', '000']) {
      const fx = makePublishFixture()
      const result = runPublish(fx, { PROBE_CODE: code })

      expect(result.status, code).not.toBe(0)
      expect(result.stderr, code).toContain('refusing to publish blind')
      expect(readFileSync(fx.curlLog, 'utf8'), code).not.toContain('--upload-file')
    }
  })

  it('rejects unknown flags rather than silently ignoring them', () => {
    const { root, stubBin } = makeFixture('GLIBC_2.28')
    const result = run(root, stubBin, ['--dry-run', '--skip-bulid'])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unknown argument')
  })
})
