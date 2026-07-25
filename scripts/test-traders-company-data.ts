import assert from 'node:assert/strict'
import {
  normalizeJpTicker,
  parseTradersCompanyDataHtml,
} from '@/lib/traders-company-data'

assert.equal(normalizeJpTicker('7203'), '7203')
assert.equal(normalizeJpTicker('7203.T'), '7203')
assert.equal(normalizeJpTicker('%'), null)
assert.equal(normalizeJpTicker('7203/T'), null)

const parsed = parseTradersCompanyDataHtml(`
  <html>
    <h1>テスト株式会社</h1>
    <div class="region_title">企業データ</div>
    <div class="zone">
      <table class="data_table">
        <tr><th>特色</th><td>主力事業を展開。<br>海外も強化</td></tr>
        <tr><th>URL</th><td><a href="https://example.com/" target="_blank">公式サイト</a></td></tr>
        <tr><th>上場日</th><td><div><span>2007/04/25</span><a href="/ipo/1234">IPO銘柄詳細≫</a></div></td></tr>
        <tr><th>任意項目</th><td>掲載値</td></tr>
      </table>
    </div>
  </html>
`)

assert.ok(parsed)
assert.equal(parsed.pageName, 'テスト株式会社')
assert.equal(parsed.featureSummary, '主力事業を展開。 海外も強化')
assert.equal(parsed.companyUrl, 'https://example.com/')
assert.equal(parsed.listingDate, '2007/04/25')
assert.equal(parsed.fields['任意項目'], '掲載値')
assert.match(parsed.contentHash, /^[a-f0-9]{64}$/)

assert.equal(parseTradersCompanyDataHtml('<html><h1>企業データなし</h1></html>'), null)

const empty = parseTradersCompanyDataHtml(`
  <div class="region_title">企業データ</div>
  <table class="data_table">
    <tr><th>特色</th><td>-</td></tr>
    <tr><th>URL</th><td></td></tr>
  </table>
`)
assert.equal(empty, null)

const unsafe = parseTradersCompanyDataHtml(`
  <div class="region_title">企業データ</div>
  <table class="data_table">
    <tr><th>特色</th><td>特色あり</td></tr>
    <tr><th>URL</th><td><a href="javascript:alert(1)">危険</a></td></tr>
  </table>
`)
assert.ok(unsafe)
assert.equal(unsafe.companyUrl, null)

console.log('traders company data parser: ok')
