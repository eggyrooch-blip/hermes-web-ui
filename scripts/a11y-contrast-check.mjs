#!/usr/bin/env node
// Static contrast lint for the Pure Ink theme.
//
// Reads the CSS custom properties out of styles/variables.scss for both `:root`
// and `.dark` variants, computes WCAG contrast ratios for the foreground/
// background pairs that make up the bulk of the UI, and exits non-zero if any
// pair under-shoots the requested threshold (4.5:1 for body text by default,
// 3:1 for large text and graphical elements).
//
// Usage: node scripts/a11y-contrast-check.mjs
//        npm run a11y:contrast

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const VARIABLES_FILE = resolve('packages/client/src/styles/variables.scss')

if (!existsSync(VARIABLES_FILE)) {
  console.error(`[a11y-contrast] file not found: ${VARIABLES_FILE}`)
  process.exit(2)
}

const source = readFileSync(VARIABLES_FILE, 'utf-8')

// Crude block-level parser: capture the body of `:root { ... }` and
// `.dark { ... }`. We only care about CSS custom property declarations.
function captureBlock(label) {
  const re = new RegExp(String.raw`${label}\s*\{([\s\S]*?)\}`, 'm')
  const m = source.match(re)
  if (!m) throw new Error(`Could not find ${label} block in variables.scss`)
  const map = new Map()
  for (const line of m[1].split('\n')) {
    const decl = line.match(/--([\w-]+):\s*([^;]+);/)
    if (!decl) continue
    map.set(decl[1].trim(), decl[2].trim())
  }
  return map
}

const lightVars = captureBlock(':root')
const darkVars = captureBlock('\\.dark')

function hexToRgb(hex) {
  const m = hex.replace(/^#/, '')
  if (m.length === 3) {
    return [parseInt(m[0] + m[0], 16), parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16)]
  }
  if (m.length !== 6) throw new Error(`unsupported color literal: ${hex}`)
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)]
}

function relLuminance([r, g, b]) {
  const channel = c => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(fg, bg) {
  const l1 = relLuminance(hexToRgb(fg))
  const l2 = relLuminance(hexToRgb(bg))
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

const PAIRS = [
  // [label, fgVar, bgVar, threshold]
  ['body text on app bg', 'text-primary', 'bg-primary', 4.5],
  ['body text on card', 'text-primary', 'bg-card', 4.5],
  ['secondary text on bg', 'text-secondary', 'bg-primary', 4.5],
  ['muted text on bg', 'text-muted', 'bg-primary', 4.5],
  ['muted text on sidebar', 'text-muted', 'bg-sidebar', 4.5],
  ['accent on bg (large)', 'accent-primary', 'bg-primary', 3.0],
  ['error on bg (large)', 'error', 'bg-primary', 3.0],
]

let failures = 0

for (const [theme, vars] of [['light', lightVars], ['dark', darkVars]]) {
  console.log(`\n--- ${theme} theme ---`)
  for (const [label, fgKey, bgKey, threshold] of PAIRS) {
    const fg = vars.get(fgKey)
    const bg = vars.get(bgKey)
    if (!fg || !bg) {
      console.warn(`  skip "${label}": missing var (${fgKey} or ${bgKey})`)
      continue
    }
    if (!fg.startsWith('#') || !bg.startsWith('#')) {
      // Variables that delegate to other variables (var(--…)) — skip silently.
      continue
    }
    const ratio = contrast(fg, bg)
    const pass = ratio >= threshold
    if (!pass) failures++
    console.log(`  ${pass ? 'OK ' : 'FAIL'} ${label.padEnd(28)} ${fg} on ${bg}  =  ${ratio.toFixed(2)}:1  (need ≥${threshold})`)
  }
}

if (failures > 0) {
  console.error(`\n[a11y-contrast] FAIL: ${failures} pair(s) below threshold`)
  process.exit(1)
}
console.log(`\n[a11y-contrast] OK`)
