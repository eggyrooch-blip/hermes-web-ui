import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')

// `.ftask/ci.yml` is the single source for the merge gate; GitLab reads the
// RENDERED copy from gates/web-ui.yml@sunke/hermes-ci-gates, so a mistake here
// is only visible after a sync. These assertions are the fast half of that loop.
const manifest = yaml.load(readFileSync(join(repoRoot, '.ftask', 'ci.yml'), 'utf8')) as {
  image: string
  extra_jobs: string
}
const extraJobs = yaml.load(manifest.extra_jobs) as Record<string, Record<string, unknown>>

describe('.ftask/ci.yml package job', () => {
  const job = () => extraJobs.package

  it('exists and runs the packaging script rather than inlining the logic', () => {
    // The logic lives in a script so it can be tested and run locally; a job that
    // grew its own copy would drift from what package-release-script.test.ts proves.
    expect(job()).toBeDefined()
    expect(job().script).toEqual(['bash scripts/package-release.sh'])
  })

  it('builds on bullseye, not the default bookworm image', () => {
    // Production is CentOS Stream 9 (glibc 2.34). bookworm is glibc 2.36 and its
    // node-pty cannot load there. The default image is bookworm, so this job MUST
    // override it — and this test is what notices if someone drops the override.
    expect(manifest.image).toContain('bookworm')
    expect(job().image).toBe('docker.io/library/node:24-bullseye')
  })

  it('installs binutils for objdump and nothing for compression', () => {
    // objdump (binutils) reads the glibc symbols and does not ship in the node
    // image. Compression is gzip, which tar has built in — production has no
    // zstd, so an apt line that reintroduced it would be a sign the artifact
    // format drifted back to something production cannot unpack.
    const before = (job().before_script as string[]).join(' ')
    expect(before).toContain('binutils')
    expect(before).not.toContain('zstd')
  })

  it('runs only on the default branch and blocks nothing', () => {
    // Regression guard from the SPEC: MR pipelines must keep the same job set and
    // the same duration. `needs: []` also detaches it from the stage ordering, so
    // it never sits behind the test tier on main either.
    expect(job().rules).toEqual([{ if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' }])
    expect(job().needs).toEqual([])
    expect(job().timeout).toBe('40m')
  })

  it('serialises pipelines that share a commit', () => {
    // Two pipelines for one sha (a retry racing a scheduled run) would both probe
    // the registry, both see nothing, and both upload. GitLab runs one job per
    // resource_group at a time, which makes probe-then-upload indivisible. The
    // key carries the sha so unrelated commits never queue behind each other.
    expect(job().resource_group).toBe('webui-release-$CI_COMMIT_SHA')
  })

  it('sits in a stage the renderer actually emits', () => {
    // `ftask ci sync` hardcodes these four stages and refuses to render a job in
    // any other; a fifth would mean changing ftask-kit.
    expect(['policy', 'test', 'full-test', 'leak']).toContain(job().stage)
  })

  it('leaves the merge-request jobs untouched', () => {
    for (const name of ['policy', 'leak']) {
      expect(extraJobs[name]).toBeDefined()
      expect(JSON.stringify(extraJobs[name].rules)).toContain('merge_request_event')
    }
  })
})
