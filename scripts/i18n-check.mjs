#!/usr/bin/env node
// i18n key parity check.
//
// Loads every locale under packages/client/src/i18n/locales/ via esbuild's
// transform API (already a project devDep), walks each exported object, and
// confirms every locale has the same set of leaf keys. Diverging keys exit
// non-zero so this can be wired into CI.
//
// Usage: node scripts/i18n-check.mjs
//        npm run i18n:check

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import { transformSync } from 'esbuild'

const LOCALES_DIR = resolve('packages/client/src/i18n/locales')
const REFERENCE = 'en'

if (!existsSync(LOCALES_DIR)) {
  console.error(`[i18n-check] locales directory not found: ${LOCALES_DIR}`)
  process.exit(2)
}

function flattenKeys(value, prefix, out) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    out.add(prefix)
    return
  }
  for (const key of Object.keys(value)) {
    flattenKeys(value[key], prefix ? `${prefix}.${key}` : key, out)
  }
}

async function loadLocale(file) {
  const tsSource = readFileSync(resolve(LOCALES_DIR, file), 'utf-8')
  const { code } = transformSync(tsSource, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
  })
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  const mod = await import(dataUrl)
  if (!mod.default || typeof mod.default !== 'object') {
    throw new Error(`${file} has no default export object`)
  }
  const set = new Set()
  flattenKeys(mod.default, '', set)
  return set
}

const files = readdirSync(LOCALES_DIR).filter(f => f.endsWith('.ts')).sort()
if (!files.includes(`${REFERENCE}.ts`)) {
  console.error(`[i18n-check] reference locale ${REFERENCE}.ts is missing`)
  process.exit(2)
}

const reference = await loadLocale(`${REFERENCE}.ts`)

let mismatched = 0
let total = 1
for (const file of files) {
  const name = basename(file, '.ts')
  if (name === REFERENCE) continue
  total++
  const keys = await loadLocale(file)

  const missing = [...reference].filter(k => !keys.has(k))
  const extra = [...keys].filter(k => !reference.has(k))

  if (missing.length || extra.length) {
    mismatched++
    console.error(`\n[i18n-check] ${name}.ts diverges from ${REFERENCE}.ts`)
    if (missing.length) {
      console.error(`  missing (${missing.length}):`)
      for (const k of missing.slice(0, 30)) console.error(`    - ${k}`)
      if (missing.length > 30) console.error(`    ... and ${missing.length - 30} more`)
    }
    if (extra.length) {
      console.error(`  extra (${extra.length}):`)
      for (const k of extra.slice(0, 30)) console.error(`    + ${k}`)
      if (extra.length > 30) console.error(`    ... and ${extra.length - 30} more`)
    }
  }
}

if (mismatched > 0) {
  console.error(`\n[i18n-check] FAIL: ${mismatched} locale(s) diverge from ${REFERENCE}.ts`)
  process.exit(1)
}

console.log(`[i18n-check] OK: ${total} locales aligned (${reference.size} keys each)`)
