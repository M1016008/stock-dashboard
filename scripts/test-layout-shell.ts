import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const layout = fs.readFileSync(path.join(root, 'app/layout.tsx'), 'utf8')
const header = fs.readFileSync(path.join(root, 'components/layout/Header.tsx'), 'utf8')
const css = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8')

assert.match(
  layout,
  /<div className="site-header-stack">[\s\S]*?<Header \/>[\s\S]*?<DataStatusBar \/>[\s\S]*?<\/div>/,
  'Header and DataStatusBar must share the fixed header stack.',
)
assert.doesNotMatch(
  header,
  /<header className="[^"]*\bsticky\b/,
  'Header must not establish a second sticky layer inside site-header-stack.',
)
assert.equal(
  (header.match(/<nav className="header-primary-nav/g) ?? []).length,
  1,
  'The primary navigation must render once instead of relying on competing responsive copies.',
)
assert.doesNotMatch(
  header,
  /<nav className="[^"]*\bhidden\b[^"]*\blg:flex\b/,
  'The primary navigation must not depend on hidden/lg:flex utility precedence.',
)
assert.match(
  css,
  /\.header-primary-nav\s*\{[\s\S]*?display:\s*flex;[\s\S]*?\}/,
  'The primary navigation must be visible without a responsive utility override.',
)
assert.doesNotMatch(
  header,
  /header-market-context[^"]*\bhidden\b/,
  'Market clocks must never depend on a hidden responsive utility.',
)
assert.match(
  css,
  /\.header-primary-nav\s*,\s*\.header-market-context\s*\{[\s\S]*?display:\s*flex;[\s\S]*?\}/,
  'Primary navigation and market clocks must be visible at every viewport width.',
)
assert.match(
  css,
  /\.header-market-context\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?\}/,
  'Market clocks must wrap instead of disappearing when space is limited.',
)
assert.doesNotMatch(
  header,
  /max-w-\[1480px\][^"]*\blg:flex-nowrap\b/,
  'The header top row must be allowed to wrap when all clocks do not fit.',
)
assert.match(
  css,
  /@media\s*\(min-width:\s*1024px\)[\s\S]*?\.header-primary-nav\s*\{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?\}/,
  'Desktop navigation must remain on one line.',
)
assert.match(
  css,
  /\.site-header-stack\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*0;[\s\S]*?z-index:\s*30;[\s\S]*?\}/,
  'The complete header stack must remain fixed at the top.',
)
assert.match(
  css,
  /\.stock-detail-sticky\s*\{[\s\S]*?position:\s*relative;[\s\S]*?top:\s*auto;[\s\S]*?z-index:\s*20;[\s\S]*?\}/,
  'Stock navigation must remain in normal flow when the header can wrap.',
)
assert.match(
  css,
  /@media\s*\(min-width:\s*1440px\)[\s\S]*?\.stock-detail-sticky\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*131px;[\s\S]*?\}/,
  'Stock navigation may become sticky only where the full clock row fits.',
)
assert.match(css, /html\s*\{\s*min-height:\s*100%;\s*\}/)
assert.match(css, /body\s*\{\s*min-height:\s*100vh;\s*\}/)
assert.doesNotMatch(
  css,
  /html\s*,\s*body\s*\{\s*height:\s*100%;\s*\}/,
  'A fixed body height constrains sticky elements on long pages.',
)

console.log('layout shell regression tests passed')
