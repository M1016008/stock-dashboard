import assert from 'node:assert/strict'
import fs from 'node:fs'

const files = {
  momentum: fs.readFileSync('app/us/market-momentum/page.tsx', 'utf8'),
  sectors: fs.readFileSync('app/us/sectors/page.tsx', 'utf8'),
  parts: fs.readFileSync('components/us/UsMarketMomentumParts.tsx', 'utf8'),
  sectorPit: fs.readFileSync('components/us/UsSectorPitUnavailable.tsx', 'utf8'),
  sectorTable: fs.readFileSync('components/us/UsSectorRankingTable.tsx', 'utf8'),
  nav: fs.readFileSync('components/us/UsAnalysisNav.tsx', 'utf8'),
  globalNav: fs.readFileSync('components/layout/navigation.ts', 'utf8'),
}

for (const [name, source] of Object.entries(files)) {
  assert.doesNotMatch(source, /https?:\/\/(?:localhost|127\.0\.0\.1)/, `${name} must keep browser reads same-origin`)
}

assert.match(files.momentum, /loadUsMarketIntelligence/, 'momentum page must use the deterministic US intelligence contract')
assert.match(files.momentum, /classificationAvailability === 'CURRENT'/, 'current-only classification must be explicitly gated')
assert.match(files.momentum, /UsMarketMomentumContextUnavailable/, 'historical momentum must explain unavailable classification context')
assert.match(files.momentum, /US_LANE_ORDER/, 'all four deterministic momentum lanes must render')
assert.doesNotMatch(files.momentum, /exec(?:All|Get)|execUsAnalytics/, 'presentation must not bypass the read model')

assert.match(files.sectors, /classificationAvailability !== 'CURRENT'/, 'historical sector analysis must fail closed')
assert.match(files.sectors, /UsSectorPitUnavailable/, 'historical sector analysis must render an explicit PIT limitation')
assert.match(files.sectors, /badge=\{data\?\.date \? \(data\.isLatest \? 'SIC区分・最新日のみ' : '過去日は集計外'\)/, 'badge must stay short enough for 390px')
assert.match(files.sectors, /StockBoard SIC division market map/, 'sector map must be present')
assert.match(files.sectors, /title="StockBoard SIC division ranking"/, 'ranking heading must use StockBoard SIC division terminology')
assert.doesNotMatch(files.sectors, /title="Sector ranking"/, 'generic "Sector ranking" heading must not return')
assert.match(files.sectors, /SIC industry ranking/, 'industry ranking must be present')
assert.match(files.sectors, /INDUSTRY_PAGE_SIZE = 50/, 'industry ranking must keep the initial server response bounded')
assert.match(files.sectors, /sampleMode === 'small'/, 'small-sample industries must remain available without entering the initial response')
assert.match(files.sectors, /IndustryPagination/, 'industry ranking must expose deterministic server pagination')
assert.doesNotMatch(files.sectors, /<details[\s>]/, 'collapsed sections must not serialize every small-sample row into the initial response')
assert.doesNotMatch(files.sectors, /exec(?:All|Get)|execUsAnalytics/, 'sector presentation must not bypass the read model')
assert.match(files.sectorTable, /table-fixed/, 'desktop sector tables must keep numeric columns stable')
assert.match(files.sectorTable, /line-clamp-2/, 'long SIC labels must remain readable without widening the document')
assert.match(files.sectorTable, /min-w-\[704px\]/, 'tablet table width must fit the bounded content area')
assert.doesNotMatch(files.sectorTable, /min-w-\[720px\]/, 'the previous 768px overflow width must not return')

assert.match(files.parts, /SEC SIC industry \+ StockBoard SIC division/)
assert.match(files.parts, /GICS ではなく/)
assert.match(files.parts, /historical PIT/)
assert.match(files.sectorPit, /集計そのものを行いません/, 'historical taxonomy must never be reused silently')

assert.match(files.nav, /\/us\/market-momentum/)
assert.match(files.nav, /\/us\/sectors/)
assert.match(files.globalNav, /usMarketMomentum/)
assert.match(files.globalNav, /usSectors/)

console.log('US market momentum and sector UI contract tests passed')
