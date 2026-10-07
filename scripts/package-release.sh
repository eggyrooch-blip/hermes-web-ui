#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Build ONE immutable web-ui release artifact and publish it to this project's
# GitLab generic package registry.
#
# WHY THIS EXISTS: until 2026-09-21 the release script ran `npm ci && npm run
# build` ON THE PRODUCTION HOST. hermes-1 sits on an HDD pool, so that 9.5-minute
# install/build pinned the disk and took production down with it for 13 minutes.
# The build moved here; production now only downloads and unpacks a tarball it
# never compiles.
#
# THE ARTIFACT CONTRACT (consumed by hermes-multitenancy deploy/hermes-release.sh
# — changing any of this means changing that consumer in the same breath):
#   webui-<sha40>.tar.gz    tar root: dist/ node_modules/ package.json
#                           package-lock.json ARTIFACT.json
#   webui-<sha40>.sha256    exactly "<hex>  webui-<sha40>.tar.gz"
# gzip, not zstd: the production host has no zstd, and an artifact it cannot
# unpack is no artifact at all.
# Unpacking the tar into the release directory is equivalent to having run
# `npm ci && npm run build` there: dist/server/index.js is an esbuild CJS bundle
# whose only externals are node-pty, socket.io and node:sqlite, so node_modules
# carries the production dependency tree and nothing else.
#
# WHY node:24-bullseye AND NOT node:24-bookworm: production is CentOS Stream 9
# (glibc 2.34) running /usr/bin/node v24.14.1. node-pty ships a compiled
# pty.node; built on bookworm (glibc 2.36) it links symbols the production host
# does not have and the server dies at require() time. bullseye is glibc 2.31,
# comfortably under the ceiling. That is not a preference, it is why this script
# ASSERTS the binary's highest GLIBC symbol before it will publish anything.
#
# Usage:
#   scripts/package-release.sh [--dry-run] [--skip-build] [--reuse-node-modules]
#
# Environment:
#   SHA        40-hex commit to label the artifact (default: $CI_COMMIT_SHA, else
#              `git rev-parse HEAD`)
#   OUT_DIR    where the tarball lands (default: .release-artifact)
#   NPM_CONFIG_CACHE   honoured by npm directly; CI points it inside the project
#                      so the shared cache survives between jobs
#
# Flags:
#   --dry-run             package but publish nothing (no CI credentials needed)
#   --skip-build          reuse the dist/ that is already there; skip the
#                         top-level `npm ci` and `npm run build`. TEST/DEBUG ONLY
#   --reuse-node-modules  stage the project's existing node_modules instead of
#                         installing a production tree. TEST ONLY — the result is
#                         NOT a production dependency set and must never ship
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# The production host's glibc. An artifact above this line cannot start there.
GLIBC_CEILING="2.34"
PACKAGE_NAME="webui-release"

DRY_RUN=0
SKIP_BUILD=0
REUSE_NODE_MODULES=0

die() { printf '\npackage-release: FATAL: %s\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --reuse-node-modules) REUSE_NODE_MODULES=1 ;;
    -h|--help) sed -n '1,50p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

# Both flags hand you a tree that was NOT built from this commit: --skip-build
# reuses whatever dist/ happened to be lying around, --reuse-node-modules copies
# a dev dependency tree. Either one published under a commit sha is a lie the
# deployer has no way to detect. Refused here, before a single file is touched.
if [ "$DRY_RUN" -eq 0 ]; then
  if [ "$SKIP_BUILD" -eq 1 ] || [ "$REUSE_NODE_MODULES" -eq 1 ]; then
    die "--skip-build and --reuse-node-modules produce a tree that was not built from this commit; they are allowed only with --dry-run"
  fi
fi

ROOT="$PWD"
[ -f "$ROOT/package.json" ] || die "no package.json in $ROOT — run this from the repository root"

SHA="${SHA:-${CI_COMMIT_SHA:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)}}"
case "$SHA" in
  # A short or empty sha would silently publish under a version the deployer can
  # never resolve, so the shape is a precondition, not a formatting nicety.
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) die "SHA must be a 40-character lowercase hex commit id (got '${SHA}')" ;;
esac

OUT_DIR="${OUT_DIR:-.release-artifact}"
case "$OUT_DIR" in
  /*) ;;
  *) OUT_DIR="$ROOT/$OUT_DIR" ;;
esac
TARBALL="$OUT_DIR/webui-${SHA}.tar.gz"
SIDECAR="$OUT_DIR/webui-${SHA}.sha256"

note "root      : $ROOT"
note "sha       : $SHA"
note "out dir   : $OUT_DIR"
note "mode      : dry-run=$DRY_RUN skip-build=$SKIP_BUILD reuse-node-modules=$REUSE_NODE_MODULES"

if [ "$DRY_RUN" -eq 0 ]; then
  # The artifact's VERSION is this sha. Labelling it with anything other than the
  # commit the job is running on publishes a package nobody can trace back.
  if [ -n "${CI_COMMIT_SHA:-}" ] && [ "$SHA" != "${CI_COMMIT_SHA}" ]; then
    die "SHA ($SHA) does not match CI_COMMIT_SHA (${CI_COMMIT_SHA}) — refusing to publish an artifact labelled with a different commit"
  fi

  : "${CI_JOB_TOKEN:?--dry-run not given, so this must publish: CI_JOB_TOKEN is missing}"
  : "${CI_API_V4_URL:?--dry-run not given, so this must publish: CI_API_V4_URL is missing}"
  : "${CI_PROJECT_ID:?--dry-run not given, so this must publish: CI_PROJECT_ID is missing}"

  # The whole point of the artifact is a Linux tree whose glibc ceiling has been
  # PROVEN. Off Linux the ELF check takes its n/a branch, so publishing would ship
  # an unverified — and for a Mach-O build, unusable — tarball to production.
  if [ "$(uname -s)" != "Linux" ]; then
    die "publishing requires a Linux builder (the glibc assertion is meaningless elsewhere); this host is $(uname -s). Use --dry-run."
  fi
fi

# ── sha256, portably ──────────────────────────────────────────────────────────
# GNU coreutils has sha256sum; some hosts only ship shasum. The sidecar format is
# fixed by the contract, so compute the hex and format it here rather than
# trusting either tool's default output layout.
sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "neither sha256sum nor shasum is available"
  fi
}

# ── the glibc gate ────────────────────────────────────────────────────────────
# `sort -V` orders version strings; "<= ceiling" is "the ceiling sorts last".
version_le() {
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$2" ]
}

is_elf() {
  [ -f "$1" ] || return 1
  # An ELF object starts with 0x7f 'E' 'L' 'F'. Reading the magic is cheaper and
  # more portable than depending on file(1) being installed.
  [ "$(head -c 4 "$1" | od -An -tx1 | tr -d ' \n')" = "7f454c46" ]
}

# Resolve the pty.node that node-pty will ACTUALLY dlopen, in node-pty's own
# order (lib/utils.js loadNativeModule): build/Release, build/Debug, then
# prebuilds/<platform>-<arch>. Checking a hardcoded build/Release would be wrong
# in both directions — on a host where a prebuild is used the path does not
# exist, and if node-pty ever ships a linux prebuild the gate would pass by
# inspecting a file nothing loads.
#
# On linux today there IS no prebuild in the package (win32 and darwin only), so
# node-pty's install script falls through to `node-gyp rebuild` and the answer is
# build/Release/pty.node. That is the CI case; the rest is what keeps this script
# honest on a laptop.
PTY_NODE=""
resolve_pty_node() {
  local root="$1" platform arch d
  platform="$(node -p 'process.platform')"
  arch="$(node -p 'process.arch')"
  for d in "build/Release" "build/Debug" "prebuilds/${platform}-${arch}"; do
    if [ -f "$root/$d/pty.node" ]; then
      PTY_NODE="$root/$d/pty.node"
      note "node-pty  : $d/pty.node"
      return 0
    fi
  done
  die "no pty.node under $root (checked build/Release, build/Debug, prebuilds/${platform}-${arch}) — the production tree is incomplete"
}

GLIBC_MAX="unknown"
assert_glibc() {
  local so="$1"
  [ -f "$so" ] || die "node-pty native module missing at $so — the production tree is incomplete"

  if ! is_elf "$so"; then
    # A developer laptop builds a Mach-O and there is no glibc to measure. That
    # is fine locally and NEVER fine in CI, where the whole point of the job is
    # producing a Linux artifact for a known-glibc host.
    if [ -n "${CI:-}" ]; then
      die "$so is not an ELF object — this job must build the Linux artifact, check the job image"
    fi
    GLIBC_MAX="n/a"
    note "glibc     : n/a (host build is not ELF; the ceiling is only enforceable on Linux)"
    return 0
  fi

  command -v objdump >/dev/null 2>&1 || die "objdump not found — install binutils in the job image"

  local symbols highest
  symbols="$(objdump -T "$so" | grep -o 'GLIBC_[0-9.]*' | sort -V || true)"
  [ -n "$symbols" ] || die "no GLIBC_* symbols found in $so — cannot prove it runs on the production host"
  highest="$(printf '%s\n' "$symbols" | tail -n 1)"
  GLIBC_MAX="${highest#GLIBC_}"
  GLIBC_MAX="${GLIBC_MAX%.}"

  if ! version_le "$GLIBC_MAX" "$GLIBC_CEILING"; then
    printf '\n' >&2
    echo "package-release: node-pty links GLIBC_${GLIBC_MAX}, above the production ceiling ${GLIBC_CEILING}." >&2
    echo "package-release: production is CentOS Stream 9 (glibc ${GLIBC_CEILING}); this artifact would fail at require()." >&2
    echo "package-release: build on node:24-bullseye (glibc 2.31), not bookworm (2.36)." >&2
    die "glibc ceiling exceeded: ${GLIBC_MAX} > ${GLIBC_CEILING}"
  fi
  note "glibc     : max symbol GLIBC_${GLIBC_MAX} <= ceiling ${GLIBC_CEILING} — ok"
}

# ── build ─────────────────────────────────────────────────────────────────────
step "Preparing $OUT_DIR"
# NEVER `rm -rf "$OUT_DIR"`. OUT_DIR is user-supplied, and `OUT_DIR=..` or
# `OUT_DIR=$HOME` would take the caller's tree with it. This run owns exactly one
# directory — its own mktemp staging dir — and exactly two files, the archive and
# its sidecar, which it overwrites by name. Everything else in OUT_DIR is someone
# else's and is left alone.
mkdir -p "$OUT_DIR"
STAGE="$(mktemp -d "$OUT_DIR/stage.XXXXXXXX")"
trap 'if [ -n "${STAGE:-}" ]; then rm -rf "$STAGE" 2>/dev/null || true; fi' EXIT
note "staging   : $STAGE (removed on exit)"

if [ "$SKIP_BUILD" -eq 1 ]; then
  step "Skipping install + build (--skip-build); reusing the dist/ already present"
else
  step "Installing dev dependencies (npm ci --ignore-scripts)"
  # --ignore-scripts is load-bearing, not hygiene: package.json's `prepare` hook is
  # `[ -d dist ] || npm run build`, so a plain `npm ci` runs a FULL build inside the
  # install, and the explicit `npm run build` below then builds a second time. That
  # doubled build is what blew the 20m job timeout on the first real main pipeline
  # (job 3249648, 2026-09-21: 20 minutes spent entirely inside this one step).
  # Every other job in this gate installs the same way.
  npm ci --ignore-scripts --no-audit --no-fund
  # node-pty is the one native module the runtime dlopens; --ignore-scripts skipped
  # its node-gyp build, so build it back explicitly.
  npm rebuild node-pty

  step "Building (npm run build)"
  npm run build
fi

[ -d "$ROOT/dist" ] || die "dist/ does not exist — nothing was built"
[ -f "$ROOT/dist/server/index.js" ] || die "dist/server/index.js missing — the server bundle did not build"

# ── stage the production tree ─────────────────────────────────────────────────
# The production node_modules is installed into a SEPARATE directory on purpose.
# Running `npm ci --omit=dev` in the project root would delete the dev tree the
# rest of the job (and, locally, every sibling worktree sharing it) still needs.
step "Staging production tree in $STAGE"
cp "$ROOT/package.json" "$STAGE/package.json"
cp "$ROOT/package-lock.json" "$STAGE/package-lock.json"

if [ "$REUSE_NODE_MODULES" -eq 1 ]; then
  note "reusing the existing node_modules (--reuse-node-modules; not a production tree)"
  [ -d "$ROOT/node_modules" ] || die "--reuse-node-modules given but node_modules/ does not exist"
  cp -R "$ROOT/node_modules" "$STAGE/node_modules"
else
  step "Installing production dependencies (npm ci --omit=dev) in the staging dir"
  # --ignore-scripts is not optional here, and not only for supply-chain reasons.
  # package.json carries `"prepare": "[ -d dist ] || npm run build"`. npm runs
  # `prepare` after `npm ci` in any directory holding a package.json, so without
  # this flag the staging install tries to BUILD THE PROJECT inside the staging
  # dir — which has no scripts/, no sources, and no business building anything.
  # Measured 2026-09-21: it dies on `Cannot find module .../stage/scripts/
  # generate-openapi.mjs` and takes the whole job down with it.
  #
  # node-pty is then rebuilt by name. It is the only production dependency with a
  # native component (the rest of `dependencies` is pure JS), and its install
  # script IS its build, so skipping every script means building this one back
  # explicitly rather than hoping a prebuilt binary showed up.
  ( cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund )
  ( cd "$STAGE" && npm rebuild node-pty )
fi

step "Copying dist/ into the staging dir"
cp -R "$ROOT/dist" "$STAGE/dist"

step "Asserting the node-pty native module against the production glibc"
resolve_pty_node "$STAGE/node_modules/node-pty"
assert_glibc "$PTY_NODE"

# ── manifest ──────────────────────────────────────────────────────────────────
step "Writing ARTIFACT.json"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NODE_VERSION="$(node -v 2>/dev/null || echo unknown)"
IMAGE="${CI_JOB_IMAGE:-local}"
cat > "$STAGE/ARTIFACT.json" <<JSON
{
  "sha": "${SHA}",
  "built_at": "${BUILT_AT}",
  "node": "${NODE_VERSION}",
  "image": "${IMAGE}",
  "glibc_max": "${GLIBC_MAX}"
}
JSON
cat "$STAGE/ARTIFACT.json"

# ── pack ──────────────────────────────────────────────────────────────────────
step "Packing $TARBALL"
# pigz is gzip with every core working; its output is ordinary gzip, so the
# deployer cannot tell which one ran. It is an optimisation and nothing depends
# on it being installed — plain `tar -czf` is the guaranteed path.
if command -v pigz >/dev/null 2>&1; then
  note "compressing with pigz (parallel gzip)"
  tar -C "$STAGE" -cf - dist node_modules package.json package-lock.json ARTIFACT.json | pigz -6 > "$TARBALL"
else
  tar -C "$STAGE" -czf "$TARBALL" dist node_modules package.json package-lock.json ARTIFACT.json
fi

step "Writing $SIDECAR"
TAR_HEX="$(sha256_hex "$TARBALL")"
printf '%s  %s\n' "$TAR_HEX" "webui-${SHA}.tar.gz" > "$SIDECAR"
cat "$SIDECAR"

step "Artifact summary"
note "tarball   : $(ls -l "$TARBALL" | awk '{print $5}') bytes ($(du -h "$TARBALL" | awk '{print $1}'))"
note "staged    : $(du -sh "$STAGE" | awk '{print $1}')"
note "sha256    : $TAR_HEX"
# `tar -tf … | head -20` is a job-killer, not a cosmetic choice. head exits after
# 20 lines, the kernel sends SIGPIPE to tar, `pipefail` propagates tar's death,
# and `set -e` ends the script — after packaging and BEFORE publishing. It hides
# on a small listing (tar's output fits the 64KB pipe buffer and it finishes
# before head leaves) and appears on a real 2000-entry artifact. Materialise the
# listing, then read the file: no pipe, no signal.
LISTING="$STAGE/.contents.txt"
tar -tf "$TARBALL" > "$LISTING"
note "entries   : $(wc -l < "$LISTING" | tr -d ' ')"
echo "    contents (first 20 entries):"
sed -n '1,20p' "$LISTING" | sed 's/^/      /'

# ── publish ───────────────────────────────────────────────────────────────────
if [ "$DRY_RUN" -eq 1 ]; then
  step "--dry-run: nothing published"
  exit 0
fi

BASE_URL="${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/packages/generic/${PACKAGE_NAME}/${SHA}"

publish() {
  local file="$1" name="$2"
  note "PUT ${BASE_URL}/${name}"
  # --fail turns a 4xx/5xx into a non-zero exit; without it curl happily writes
  # the error page and reports success, and the deployer later downloads HTML.
  curl --fail --silent --show-error --retry 3 --retry-delay 5 \
    --header "JOB-TOKEN: ${CI_JOB_TOKEN}" \
    --upload-file "$file" \
    "${BASE_URL}/${name}" \
    || die "upload of ${name} failed"
  printf '\n'
}

# ── is this sha already published? ────────────────────────────────────────────
# A generic package version is NOT write-protected: by default GitLab accepts a
# second upload under the same filename and keeps both, so a re-run of main's
# pipeline silently leaves two files where the deployer expects one. Probe the
# sidecar first — it is 100 bytes and it carries the archive's hash, so one GET
# answers both "does this exist" and "is it the same artifact".
# ── is a COMPLETE package already published for this sha? ─────────────────────
# A release's identity is its COMMIT, not its compressed bytes. Two runs of one
# sha build from the same sources and the same lockfile, but they are not
# byte-identical and never will be: ARTIFACT.json carries built_at to the second
# and the staged tree's mtimes are fresh every run. Measured — two runs a second
# apart produced two different sha256s. So comparing bytes would fail every
# retried pipeline, which is the opposite of what this check exists for.
#
# The question is therefore "does a COMPLETE package already exist under this
# sha", and complete means a well-formed sidecar plus a readable archive.
step "Checking whether ${SHA} is already published"
PUBLISHED_SIDECAR="$STAGE/.published.sha256"

# The sidecar is ~100 bytes and carries the answer, so fetch it whole.
SIDECAR_CODE="$(curl --silent --show-error --location \
  --header "JOB-TOKEN: ${CI_JOB_TOKEN}" \
  --output "$PUBLISHED_SIDECAR" \
  --write-out '%{http_code}' \
  "${BASE_URL}/webui-${SHA}.sha256" || true)"
[ -n "$SIDECAR_CODE" ] || SIDECAR_CODE="000"
note "registry  : sidecar HTTP ${SIDECAR_CODE}"

# Exactly one line, exactly the contract's shape. awk counts an unterminated
# final line too, so a sidecar is judged on its content rather than on whether
# the transfer kept the trailing newline.
sidecar_is_wellformed() {
  [ "$(awk 'END{print NR}' "$1")" = "1" ] || return 1
  grep -Eq "^[0-9a-f]{64}  webui-${SHA}\.tar\.gz$" "$1"
}

PARTIAL=0
case "$SIDECAR_CODE" in
  404)
    note "not published yet — proceeding"
    ;;
  200)
    if ! sidecar_is_wellformed "$PUBLISHED_SIDECAR"; then
      echo "package-release: the published sidecar reads:" >&2
      head -c 400 "$PUBLISHED_SIDECAR" >&2
      printf '\n' >&2
      die "published sidecar for ${SHA} is not '<64hex>  webui-${SHA}.tar.gz' — refusing to guess at a corrupt version"
    fi

    # A one-byte ranged GET rather than HEAD: it proves the object is readable,
    # and every object store answers a range, while HEAD support is uneven. 200
    # (server ignored the range) and 206 (it honoured it) are both a yes.
    TAR_CODE="$(curl --silent --show-error --location --range 0-0 \
      --header "JOB-TOKEN: ${CI_JOB_TOKEN}" \
      --output /dev/null \
      --write-out '%{http_code}' \
      "${BASE_URL}/webui-${SHA}.tar.gz" || true)"
    [ -n "$TAR_CODE" ] || TAR_CODE="000"
    note "registry  : archive HTTP ${TAR_CODE}"

    case "$TAR_CODE" in
      2??)
        step "already published (complete), skipping"
        note "${SHA} has a well-formed sidecar and a readable archive; nothing to upload"
        exit 0
        ;;
      404)
        # Sidecar with no archive: the version is half-written, whoever wrote it.
        # The deployer needs both files, so finish it instead of leaving it broken.
        note "PARTIAL PUBLISH detected: sidecar present, archive missing — completing the version"
        PARTIAL=1
        ;;
      *)
        die "unexpected HTTP ${TAR_CODE} probing ${BASE_URL}/webui-${SHA}.tar.gz — refusing to publish blind"
        ;;
    esac
    ;;
  *)
    # 401, 403, 5xx or a curl-level 000: the question went unanswered, and
    # uploading anyway is publishing blind over a registry of unknown state.
    die "unexpected HTTP ${SIDECAR_CODE} probing ${BASE_URL}/webui-${SHA}.sha256 — refusing to publish blind"
    ;;
esac

if [ "$PARTIAL" -eq 1 ]; then
  note "repairing a partial publish: uploading the archive, then the sidecar"
fi

step "Publishing to the generic package registry"
publish "$TARBALL" "webui-${SHA}.tar.gz"
publish "$SIDECAR" "webui-${SHA}.sha256"

step "Published ${PACKAGE_NAME} version ${SHA}"
