import assert from 'node:assert/strict'
import {
  parseLargeHolding,
  parseMajorShareholders,
  parsePolicyHoldings,
} from '@/lib/edinet-xbrl'

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:jpcrp_cor="http://example.test">
  <xbrli:context id="major-1">
    <xbrli:entity><xbrli:identifier scheme="test">E00001</xbrli:identifier></xbrli:entity>
    <xbrli:scenario>
      <xbrldi:explicitMember dimension="jpcrp_cor:MajorShareholdersAxis">jpcrp_cor:MajorShareholderOneMember</xbrldi:explicitMember>
    </xbrli:scenario>
  </xbrli:context>
  <xbrli:context id="policy-1">
    <xbrli:entity><xbrli:identifier scheme="test">E00001</xbrli:identifier></xbrli:entity>
    <xbrli:scenario>
      <xbrldi:explicitMember dimension="jpcrp_cor:SpecifiedInvestmentEquitySecuritiesAxis">jpcrp_cor:PolicyOneMember</xbrldi:explicitMember>
    </xbrli:scenario>
  </xbrli:context>
  <jpcrp_cor:NameMajorShareholders contextRef="major-1">テスト信託銀行</jpcrp_cor:NameMajorShareholders>
  <jpcrp_cor:NumberOfSharesHeld contextRef="major-1" unitRef="shares">1230000</jpcrp_cor:NumberOfSharesHeld>
  <jpcrp_cor:ShareholdingRatio contextRef="major-1" unitRef="pure">12.3</jpcrp_cor:ShareholdingRatio>
  <jpcrp_cor:NameOfIssuer contextRef="policy-1">政策保有株式会社</jpcrp_cor:NameOfIssuer>
  <jpcrp_cor:NumberOfShares contextRef="policy-1" unitRef="shares">50000</jpcrp_cor:NumberOfShares>
  <jpcrp_cor:BalanceSheetAmount contextRef="policy-1" unitRef="JPY">250000000</jpcrp_cor:BalanceSheetAmount>
  <jpcrp_cor:PurposeOfHolding contextRef="policy-1">取引関係の維持</jpcrp_cor:PurposeOfHolding>
  <jpcrp_cor:NameOfLargeShareholdingReporter contextRef="major-1">大量保有者A</jpcrp_cor:NameOfLargeShareholdingReporter>
  <jpcrp_cor:TotalNumberOfStocksEtcHeld contextRef="major-1">7800000</jpcrp_cor:TotalNumberOfStocksEtcHeld>
  <jpcrp_cor:RatioOfStockEtcHolding contextRef="major-1">7.8</jpcrp_cor:RatioOfStockEtcHolding>
  <jpcrp_cor:PreviousRatioOfStockEtcHolding contextRef="major-1">6.9</jpcrp_cor:PreviousRatioOfStockEtcHolding>
  <jpcrp_cor:PurposeOfStockHolding contextRef="major-1">純投資</jpcrp_cor:PurposeOfStockHolding>
</xbrli:xbrl>`

const major = parseMajorShareholders(xml)
assert.equal(major.length, 1)
assert.deepEqual(major[0], {
  holderName: 'テスト信託銀行',
  shares: 1_230_000,
  holdingRatio: 12.3,
})

const policy = parsePolicyHoldings(xml)
assert.equal(policy.length, 1)
assert.equal(policy[0]?.issuerName, '政策保有株式会社')
assert.equal(policy[0]?.bookValue, 250_000_000)
assert.equal(policy[0]?.purpose, '取引関係の維持')

const large = parseLargeHolding(xml)
assert.equal(large.holderName, '大量保有者A')
assert.equal(large.shares, 7_800_000)
assert.equal(large.holdingRatio, 7.8)
assert.equal(large.previousHoldingRatio, 6.9)
assert.equal(large.purpose, '純投資')

console.log('EDINET XBRL parser tests passed')
