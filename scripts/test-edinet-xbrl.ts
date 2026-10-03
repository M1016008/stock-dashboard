import assert from 'node:assert/strict'
import {
  parseCompanyOverview,
  parseEmployeeInformation,
  parseLargeHolding,
  parseMajorShareholders,
  parseOfficerInformation,
  parsePolicyHoldings,
  parseSegmentInformation,
} from '@/lib/edinet-xbrl'
import { XbrlFactReader } from '@/lib/edinet-xbrl-facts'

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:jpcrp_cor="http://example.test" xmlns:jpigp_cor="http://example.test/ifrs" xmlns:test="http://example.test/custom">
  <xbrli:context id="major-1">
    <xbrli:entity><xbrli:identifier scheme="test">E00001</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>2026-03-31</xbrli:instant></xbrli:period>
    <xbrli:scenario>
      <xbrldi:explicitMember dimension="jpcrp_cor:MajorShareholdersAxis">jpcrp_cor:MajorShareholderOneMember</xbrldi:explicitMember>
    </xbrli:scenario>
  </xbrli:context>
  <xbrli:context id="policy-current">
    <xbrli:entity><xbrli:identifier scheme="test">E00001</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>2026-03-31</xbrli:instant></xbrli:period>
    <xbrli:scenario>
      <xbrldi:explicitMember dimension="jpcrp_cor:SpecifiedInvestmentEquitySecuritiesAxis">test:PolicyOneMember</xbrldi:explicitMember>
    </xbrli:scenario>
  </xbrli:context>
  <xbrli:context id="policy-prior">
    <xbrli:entity><xbrli:identifier scheme="test">E00001</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>2025-03-31</xbrli:instant></xbrli:period>
    <xbrli:scenario>
      <xbrldi:explicitMember dimension="jpcrp_cor:SpecifiedInvestmentEquitySecuritiesAxis">test:PolicyOneMember</xbrldi:explicitMember>
    </xbrli:scenario>
  </xbrli:context>
  <xbrli:context id="non-consolidated">
    <xbrli:entity><xbrli:identifier scheme="test">E00001</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>2025-04-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period>
    <xbrli:scenario>
      <xbrldi:explicitMember dimension="jpcrp_cor:ConsolidatedOrNonConsolidatedAxis">jpcrp_cor:NonConsolidatedMember</xbrldi:explicitMember>
    </xbrli:scenario>
  </xbrli:context>
  <xbrli:context id="employee-consolidated">
    <xbrli:entity><xbrli:identifier scheme="test">E00001</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>2026-03-31</xbrli:instant></xbrli:period>
  </xbrli:context>
  <xbrli:context id="employee-segment">
    <xbrli:entity><xbrli:identifier scheme="test">E00001</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>2026-03-31</xbrli:instant></xbrli:period>
    <xbrli:scenario>
      <xbrldi:explicitMember dimension="jpcrp_cor:OperatingSegmentsAxis">test:AutomotiveMember</xbrldi:explicitMember>
    </xbrli:scenario>
  </xbrli:context>
  <xbrli:context id="filing-date">
    <xbrli:entity><xbrli:identifier scheme="test">E00001</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>2026-06-10</xbrli:instant></xbrli:period>
  </xbrli:context>
  <xbrli:context id="officer-current">
    <xbrli:entity><xbrli:identifier scheme="test">E00001</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>2026-06-10</xbrli:instant></xbrli:period>
    <xbrli:scenario>
      <xbrldi:explicitMember dimension="jpcrp_cor:DirectorsAndOtherOfficersAxis">test:OfficerOneMember</xbrldi:explicitMember>
    </xbrli:scenario>
  </xbrli:context>
  <xbrli:context id="officer-proposal">
    <xbrli:entity><xbrli:identifier scheme="test">E00001</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>2026-06-10</xbrli:instant></xbrli:period>
    <xbrli:scenario>
      <xbrldi:explicitMember dimension="jpcrp_cor:DirectorsAndOtherOfficersProposalAxis">test:OfficerProposalMember</xbrldi:explicitMember>
    </xbrli:scenario>
  </xbrli:context>
  <xbrli:context id="officer-outside">
    <xbrli:entity><xbrli:identifier scheme="test">E00001</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>2026-06-10</xbrli:instant></xbrli:period>
    <xbrli:scenario>
      <xbrldi:explicitMember dimension="jpcrp_cor:DirectorsAndOtherOfficersAxis">test:OfficerOutsideMember</xbrldi:explicitMember>
    </xbrli:scenario>
  </xbrli:context>
  <xbrli:context id="segment-auto-duration">
    <xbrli:entity><xbrli:identifier scheme="test">E00001</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>2025-04-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period>
    <xbrli:scenario>
      <xbrldi:explicitMember dimension="jpcrp_cor:OperatingSegmentsAxis">test:AutomotiveReportableSegmentMember</xbrldi:explicitMember>
    </xbrli:scenario>
  </xbrli:context>
  <xbrli:context id="segment-auto-instant">
    <xbrli:entity><xbrli:identifier scheme="test">E00001</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>2026-03-31</xbrli:instant></xbrli:period>
    <xbrli:scenario>
      <xbrldi:explicitMember dimension="jpcrp_cor:OperatingSegmentsAxis">test:AutomotiveReportableSegmentMember</xbrldi:explicitMember>
    </xbrli:scenario>
  </xbrli:context>
  <xbrli:context id="segment-other-duration">
    <xbrli:entity><xbrli:identifier scheme="test">E00001</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>2025-04-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period>
    <xbrli:scenario>
      <xbrldi:explicitMember dimension="jpcrp_cor:OperatingSegmentsAxis">jpcrp_cor:OtherReportableSegmentsMember</xbrldi:explicitMember>
    </xbrli:scenario>
  </xbrli:context>
  <xbrli:context id="segment-adjustment-duration">
    <xbrli:entity><xbrli:identifier scheme="test">E00001</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>2025-04-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period>
    <xbrli:scenario>
      <xbrldi:explicitMember dimension="jpcrp_cor:OperatingSegmentsAxis">test:CorporateExpensesAndEliminationMember</xbrldi:explicitMember>
    </xbrli:scenario>
  </xbrli:context>
  <xbrli:context id="segment-typed-duration">
    <xbrli:entity><xbrli:identifier scheme="test">E00001</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>2025-04-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period>
    <xbrli:scenario>
      <xbrldi:typedMember dimension="test:BusinessSegmentsAxis"><test:SegmentName>Specialty</test:SegmentName></xbrldi:typedMember>
    </xbrli:scenario>
  </xbrli:context>
  <xbrli:context id="geography-japan-duration">
    <xbrli:entity><xbrli:identifier scheme="test">E00001</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>2025-04-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period>
    <xbrli:scenario>
      <xbrldi:explicitMember dimension="test:GeographicalAreasAxis">test:JapanMember</xbrldi:explicitMember>
    </xbrli:scenario>
  </xbrli:context>
  <xbrli:context id="major-customer-duration">
    <xbrli:entity><xbrli:identifier scheme="test">E00001</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>2025-04-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period>
    <xbrli:scenario>
      <xbrldi:typedMember dimension="test:MajorCustomersAxis"><test:CustomerName>Customer A</test:CustomerName></xbrldi:typedMember>
    </xbrli:scenario>
  </xbrli:context>
  <xbrli:unit id="shares"><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unit>
  <xbrli:unit id="pure"><xbrli:measure>xbrli:pure</xbrli:measure></xbrli:unit>
  <xbrli:unit id="JPY"><xbrli:measure>iso4217:JPY</xbrli:measure></xbrli:unit>
  <xbrli:unit id="JPYPerShare"><xbrli:divide><xbrli:unitNumerator><xbrli:measure>iso4217:JPY</xbrli:measure></xbrli:unitNumerator><xbrli:unitDenominator><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unitDenominator></xbrli:divide></xbrli:unit>
  <jpcrp_cor:WhetherConsolidatedFinancialStatementsArePreparedDEI contextRef="major-1">true</jpcrp_cor:WhetherConsolidatedFinancialStatementsArePreparedDEI>
  <jpcrp_cor:NameMajorShareholders contextRef="major-1">テスト信託銀行</jpcrp_cor:NameMajorShareholders>
  <jpcrp_cor:NumberOfSharesHeld contextRef="major-1" unitRef="shares" decimals="-3">1230000</jpcrp_cor:NumberOfSharesHeld>
  <jpcrp_cor:ShareholdingRatio contextRef="major-1" unitRef="pure" decimals="2">12.3</jpcrp_cor:ShareholdingRatio>
  <jpcrp_cor:NameOfSecuritiesDetailsOfSpecifiedInvestmentEquitySecuritiesHeldForPurposesOtherThanPureInvestmentReportingCompany contextRef="policy-current">政策保有株式会社</jpcrp_cor:NameOfSecuritiesDetailsOfSpecifiedInvestmentEquitySecuritiesHeldForPurposesOtherThanPureInvestmentReportingCompany>
  <jpcrp_cor:NumberOfSharesHeldDetailsOfSpecifiedInvestmentEquitySecuritiesHeldForPurposesOtherThanPureInvestmentReportingCompany contextRef="policy-current" unitRef="shares">50000</jpcrp_cor:NumberOfSharesHeldDetailsOfSpecifiedInvestmentEquitySecuritiesHeldForPurposesOtherThanPureInvestmentReportingCompany>
  <jpcrp_cor:BookValueDetailsOfSpecifiedInvestmentEquitySecuritiesHeldForPurposesOtherThanPureInvestmentReportingCompany contextRef="policy-current" unitRef="JPY">250000000</jpcrp_cor:BookValueDetailsOfSpecifiedInvestmentEquitySecuritiesHeldForPurposesOtherThanPureInvestmentReportingCompany>
  <jpcrp_cor:PurposeOfShareholdingOverviewOfBusinessAllianceQuantitativeEffectsOfShareholdingAndReasonForIncreaseInNumberOfSharesDetailsOfSpecifiedInvestmentSharesHeldForPurposesOtherThanPureInvestmentReportingCompany contextRef="policy-current">&lt;p&gt;取引関係の維持&lt;/p&gt;</jpcrp_cor:PurposeOfShareholdingOverviewOfBusinessAllianceQuantitativeEffectsOfShareholdingAndReasonForIncreaseInNumberOfSharesDetailsOfSpecifiedInvestmentSharesHeldForPurposesOtherThanPureInvestmentReportingCompany>
  <jpcrp_cor:NameOfSecuritiesDetailsOfSpecifiedInvestmentEquitySecuritiesHeldForPurposesOtherThanPureInvestmentReportingCompany contextRef="policy-prior">政策保有株式会社</jpcrp_cor:NameOfSecuritiesDetailsOfSpecifiedInvestmentEquitySecuritiesHeldForPurposesOtherThanPureInvestmentReportingCompany>
  <jpcrp_cor:NumberOfSharesHeldDetailsOfSpecifiedInvestmentEquitySecuritiesHeldForPurposesOtherThanPureInvestmentReportingCompany contextRef="policy-prior" unitRef="shares">40000</jpcrp_cor:NumberOfSharesHeldDetailsOfSpecifiedInvestmentEquitySecuritiesHeldForPurposesOtherThanPureInvestmentReportingCompany>
  <jpcrp_cor:BookValueDetailsOfSpecifiedInvestmentEquitySecuritiesHeldForPurposesOtherThanPureInvestmentReportingCompany contextRef="policy-prior" unitRef="JPY">200000000</jpcrp_cor:BookValueDetailsOfSpecifiedInvestmentEquitySecuritiesHeldForPurposesOtherThanPureInvestmentReportingCompany>
  <test:ScaledAmount contextRef="non-consolidated" unitRef="JPY" decimals="-3" scale="3" sign="-">123</test:ScaledAmount>
  <test:NilAmount contextRef="non-consolidated" unitRef="JPY" xsi:nil="true"/>
  <test:PerShareAmount contextRef="non-consolidated" unitRef="JPYPerShare" decimals="INF">42.5</test:PerShareAmount>
  <jpcrp_cor:DescriptionOfBusinessTextBlock contextRef="filing-date">&lt;p&gt;自動車事業と金融事業を展開しています。&lt;/p&gt;</jpcrp_cor:DescriptionOfBusinessTextBlock>
  <jpcrp_cor:CompanyHistoryTextBlock contextRef="filing-date">1933年 自動車部を設置</jpcrp_cor:CompanyHistoryTextBlock>
  <jpcrp_cor:BusinessPolicyBusinessEnvironmentIssuesToAddressEtcTextBlock contextRef="filing-date">持続的な成長を目指します。</jpcrp_cor:BusinessPolicyBusinessEnvironmentIssuesToAddressEtcTextBlock>
  <jpcrp_cor:OverviewOfAffiliatedEntitiesTextBlock contextRef="filing-date">国内外に関係会社があります。</jpcrp_cor:OverviewOfAffiliatedEntitiesTextBlock>
  <jpcrp_cor:NumberOfEmployees contextRef="employee-consolidated" unitRef="pure">390927</jpcrp_cor:NumberOfEmployees>
  <jpcrp_cor:NumberOfEmployees contextRef="employee-segment" unitRef="pure">343952</jpcrp_cor:NumberOfEmployees>
  <jpcrp_cor:NumberOfEmployees contextRef="non-consolidated" unitRef="pure">73133</jpcrp_cor:NumberOfEmployees>
  <jpcrp_cor:AverageAgeYearsInformationAboutReportingCompanyInformationAboutEmployees contextRef="non-consolidated" unitRef="pure">40.5</jpcrp_cor:AverageAgeYearsInformationAboutReportingCompanyInformationAboutEmployees>
  <jpcrp_cor:AverageLengthOfServiceYearsInformationAboutReportingCompanyInformationAboutEmployees contextRef="non-consolidated" unitRef="pure">15.1</jpcrp_cor:AverageLengthOfServiceYearsInformationAboutReportingCompanyInformationAboutEmployees>
  <jpcrp_cor:AverageAnnualSalaryInformationAboutReportingCompanyInformationAboutEmployees contextRef="non-consolidated" unitRef="JPY">10060464</jpcrp_cor:AverageAnnualSalaryInformationAboutReportingCompanyInformationAboutEmployees>
  <jpcrp_cor:NameInformationAboutDirectorsAndCorporateAuditors contextRef="officer-current">豊田 章男</jpcrp_cor:NameInformationAboutDirectorsAndCorporateAuditors>
  <jpcrp_cor:OfficialTitleOrPositionInformationAboutDirectorsAndCorporateAuditors contextRef="officer-current">取締役会長（代表取締役）</jpcrp_cor:OfficialTitleOrPositionInformationAboutDirectorsAndCorporateAuditors>
  <jpcrp_cor:CareerSummaryInformationAboutDirectorsAndCorporateAuditorsTextBlock contextRef="officer-current">1984年 入社、2023年 取締役会長</jpcrp_cor:CareerSummaryInformationAboutDirectorsAndCorporateAuditorsTextBlock>
  <jpcrp_cor:TermOfOfficeInformationAboutDirectorsAndCorporateAuditors contextRef="officer-current">（注）3</jpcrp_cor:TermOfOfficeInformationAboutDirectorsAndCorporateAuditors>
  <jpcrp_cor:NumberOfSharesHeldOrdinarySharesInformationAboutDirectorsAndCorporateAuditors contextRef="officer-current" unitRef="shares">24099000</jpcrp_cor:NumberOfSharesHeldOrdinarySharesInformationAboutDirectorsAndCorporateAuditors>
  <jpcrp_cor:NameInformationAboutDirectorsAndCorporateAuditorsProposal contextRef="officer-proposal">提案候補者</jpcrp_cor:NameInformationAboutDirectorsAndCorporateAuditorsProposal>
  <jpcrp_cor:NameInformationAboutDirectorsAndCorporateAuditors contextRef="officer-outside">岡本 薫明</jpcrp_cor:NameInformationAboutDirectorsAndCorporateAuditors>
  <jpcrp_cor:OfficialTitleOrPositionInformationAboutDirectorsAndCorporateAuditors contextRef="officer-outside">取締役</jpcrp_cor:OfficialTitleOrPositionInformationAboutDirectorsAndCorporateAuditors>
  <jpcrp_cor:CareerSummaryInformationAboutDirectorsAndCorporateAuditorsTextBlock contextRef="officer-outside">1983年 大蔵省入省</jpcrp_cor:CareerSummaryInformationAboutDirectorsAndCorporateAuditorsTextBlock>
  <jpcrp_cor:TermOfOfficeInformationAboutDirectorsAndCorporateAuditors contextRef="officer-outside">（注）3</jpcrp_cor:TermOfOfficeInformationAboutDirectorsAndCorporateAuditors>
  <jpcrp_cor:InformationAboutOfficersTextBlock contextRef="filing-date">役職名 氏名 略歴 任期 所有株式数 取締役会長 豊田 章男 略歴 （注）3 24099 取締役 岡本 薫明 略歴 （注）3 ― 計</jpcrp_cor:InformationAboutOfficersTextBlock>
  <jpcrp_cor:FootnotesDirectorsAndCorporateAuditorsTextBlock contextRef="filing-date">2 取締役 岡本 薫明は、社外取締役です。</jpcrp_cor:FootnotesDirectorsAndCorporateAuditorsTextBlock>
  <jpcrp_cor:CorporateGovernanceCompanyWithAuditAndSupervisoryCommitteeTextBlock contextRef="filing-date">社外取締役を選任し、全員を独立役員として東京証券取引所に届け出ています。</jpcrp_cor:CorporateGovernanceCompanyWithAuditAndSupervisoryCommitteeTextBlock>
  <jpcrp_cor:OutsideDirectorsAndOutsideCorporateAuditorsTextBlock contextRef="filing-date">社外取締役の選任状況を記載します。</jpcrp_cor:OutsideDirectorsAndOutsideCorporateAuditorsTextBlock>
  <jpigp_cor:OperatingRevenueFromExternalCustomersIFRS contextRef="segment-auto-duration" unitRef="JPY">900000000</jpigp_cor:OperatingRevenueFromExternalCustomersIFRS>
  <jpigp_cor:IntersegmentOperatingRevenuesIFRS contextRef="segment-auto-duration" unitRef="JPY">100000000</jpigp_cor:IntersegmentOperatingRevenuesIFRS>
  <jpigp_cor:SalesRevenuesIFRS contextRef="segment-auto-duration" unitRef="JPY">1000000000</jpigp_cor:SalesRevenuesIFRS>
  <jpigp_cor:OperatingProfitLossIFRS contextRef="segment-auto-duration" unitRef="JPY">120000000</jpigp_cor:OperatingProfitLossIFRS>
  <jpigp_cor:DepreciationAndAmortizationOperatingExpensesIFRS contextRef="segment-auto-duration" unitRef="JPY">30000000</jpigp_cor:DepreciationAndAmortizationOperatingExpensesIFRS>
  <jpigp_cor:CapitalExpendituresIFRS contextRef="segment-auto-duration" unitRef="JPY">50000000</jpigp_cor:CapitalExpendituresIFRS>
  <jpigp_cor:AssetsIFRS contextRef="segment-auto-instant" unitRef="JPY">2000000000</jpigp_cor:AssetsIFRS>
  <test:NetSales contextRef="segment-other-duration" unitRef="JPY">200000000</test:NetSales>
  <test:SegmentProfitLoss contextRef="segment-other-duration" unitRef="JPY">10000000</test:SegmentProfitLoss>
  <test:NetSales contextRef="segment-adjustment-duration" unitRef="JPY">-50000000</test:NetSales>
  <test:SegmentProfitLoss contextRef="segment-adjustment-duration" unitRef="JPY">-1000000</test:SegmentProfitLoss>
  <test:NetSales contextRef="segment-typed-duration" unitRef="JPY">300000000</test:NetSales>
  <test:SegmentProfitLoss contextRef="segment-typed-duration" unitRef="JPY">20000000</test:SegmentProfitLoss>
  <test:RevenueFromExternalCustomersIFRS contextRef="geography-japan-duration" unitRef="JPY">700000000</test:RevenueFromExternalCustomersIFRS>
  <test:RevenueFromMajorCustomer contextRef="major-customer-duration" unitRef="JPY">150000000</test:RevenueFromMajorCustomer>
  <test:PercentageOfRevenueFromMajorCustomer contextRef="major-customer-duration" unitRef="pure">0.15</test:PercentageOfRevenueFromMajorCustomer>
  <jpigp_cor:NotesSegmentInformationConsolidatedFinancialStatementsIFRSTextBlock contextRef="filing-date">セグメント情報</jpigp_cor:NotesSegmentInformationConsolidatedFinancialStatementsIFRSTextBlock>
  <jpcrp_cor:NameOfLargeShareholdingReporter contextRef="major-1">大量保有者A</jpcrp_cor:NameOfLargeShareholdingReporter>
  <jpcrp_cor:TotalNumberOfStocksEtcHeld contextRef="major-1">7800000</jpcrp_cor:TotalNumberOfStocksEtcHeld>
  <jpcrp_cor:RatioOfStockEtcHolding contextRef="major-1">7.8</jpcrp_cor:RatioOfStockEtcHolding>
  <jpcrp_cor:PreviousRatioOfStockEtcHolding contextRef="major-1">6.9</jpcrp_cor:PreviousRatioOfStockEtcHolding>
  <jpcrp_cor:PurposeOfStockHolding contextRef="major-1">純投資</jpcrp_cor:PurposeOfStockHolding>
</xbrli:xbrl>`

const reader = new XbrlFactReader(xml)
assert.equal(reader.contexts.get('major-1')?.period.kind, 'instant')
assert.equal(reader.contexts.get('major-1')?.consolidation, 'consolidated')
assert.equal(reader.contexts.get('non-consolidated')?.period.kind, 'duration')
assert.equal(reader.contexts.get('non-consolidated')?.consolidation, 'non_consolidated')
assert.equal(reader.contexts.get('policy-current')?.dimensions[0]?.member, 'test:PolicyOneMember')
assert.equal(reader.units.get('JPY')?.label, 'iso4217:JPY')
assert.equal(reader.units.get('JPYPerShare')?.label, 'iso4217:JPY/xbrli:shares')
assert.equal(reader.findFacts('ScaledAmount')[0]?.numericValue, -123_000)
assert.equal(reader.findFacts('ScaledAmount')[0]?.decimals, -3)
assert.equal(reader.findFacts('NilAmount')[0]?.numericValue, null)
assert.equal(reader.findFacts('PerShareAmount')[0]?.decimals, 'INF')
assert.equal(reader.isPrimaryContext(reader.contexts.get('employee-consolidated') ?? null), true)
assert.equal(reader.isPrimaryContext(reader.contexts.get('employee-segment') ?? null), false)
assert.deepEqual(reader.findDimension(
  reader.contexts.get('segment-typed-duration') ?? null,
  'BusinessSegmentsAxis',
), {
  axisQName: 'test:BusinessSegmentsAxis',
  axisName: 'BusinessSegmentsAxis',
  memberQName: 'Specialty',
  memberName: 'Specialty',
  memberValue: 'Specialty',
  typed: true,
})
assert.equal(
  reader.latestFact('NumberOfEmployees', {
    consolidation: 'consolidated',
    primaryContextOnly: true,
  })?.numericValue,
  390_927,
)

const major = parseMajorShareholders(reader)
assert.equal(major.length, 1)
assert.deepEqual(major[0], {
  holderName: 'テスト信託銀行',
  shares: 1_230_000,
  holdingRatio: 12.3,
})

const policy = parsePolicyHoldings(reader)
assert.equal(policy.length, 1)
assert.equal(policy[0]?.issuerName, '政策保有株式会社')
assert.equal(policy[0]?.shares, 50_000)
assert.equal(policy[0]?.bookValue, 250_000_000)
assert.equal(policy[0]?.purpose, '取引関係の維持')
assert.equal(policy[0]?.holdingType, '特定投資株式')

const large = parseLargeHolding(reader)
assert.equal(large.holderName, '大量保有者A')
assert.equal(large.shares, 7_800_000)
assert.equal(large.holdingRatio, 7.8)
assert.equal(large.previousHoldingRatio, 6.9)
assert.equal(large.purpose, '純投資')

const company = parseCompanyOverview(reader)
assert.equal(company.businessDescription?.text, '自動車事業と金融事業を展開しています。')
assert.equal(company.companyHistory?.text, '1933年 自動車部を設置')
assert.equal(company.businessPolicy?.text, '持続的な成長を目指します。')
assert.equal(company.basicDescriptionTextBlocks.length, 4)

const employees = parseEmployeeInformation(reader)
assert.equal(employees.consolidated?.employeeCount, 390_927)
assert.equal(employees.nonConsolidated?.employeeCount, 73_133)
assert.equal(employees.nonConsolidated?.averageAgeYears, 40.5)
assert.equal(employees.nonConsolidated?.averageLengthOfServiceYears, 15.1)
assert.equal(employees.nonConsolidated?.averageAnnualSalary, 10_060_464)
assert.equal(employees.nonConsolidated?.averageAnnualSalaryUnit, 'iso4217:JPY')

const officerInformation = parseOfficerInformation(reader)
assert.equal(officerInformation.officers.length, 2)
assert.equal(officerInformation.officers[0]?.name, '豊田 章男')
assert.equal(officerInformation.officers[0]?.role, '取締役会長（代表取締役）')
assert.equal(officerInformation.officers[0]?.sharesHeld, 24_099_000)
assert.equal(officerInformation.officers[0]?.sharesSource, 'structured_fact')
assert.equal(officerInformation.officers[0]?.outside, false)
assert.equal(officerInformation.officers[0]?.independent, false)
assert.equal(officerInformation.officers[1]?.name, '岡本 薫明')
assert.equal(officerInformation.officers[1]?.sharesHeld, 0)
assert.equal(officerInformation.officers[1]?.sharesSource, 'table_dash')
assert.equal(officerInformation.officers[1]?.outside, true)
assert.equal(officerInformation.officers[1]?.outsideSource, 'officer_footnote')
assert.equal(officerInformation.officers[1]?.independent, true)
assert.equal(officerInformation.officers[1]?.independentSource, 'governance_narrative')
assert.equal(officerInformation.outsideOfficerNarrative?.text, '社外取締役の選任状況を記載します。')

const segmentInformation = parseSegmentInformation(reader)
assert.equal(segmentInformation.accountingFramework, 'IFRS')
assert.equal(segmentInformation.periodEnd, '2026-03-31')
assert.equal(segmentInformation.segments.length, 4)
const automotiveSegment = segmentInformation.segments.find((segment) => segment.name === '自動車')
assert.equal(automotiveSegment?.kind, 'business')
assert.equal(automotiveSegment?.revenue?.value, 1_000_000_000)
assert.equal(automotiveSegment?.externalRevenue?.value, 900_000_000)
assert.equal(automotiveSegment?.intersegmentRevenue?.value, 100_000_000)
assert.equal(automotiveSegment?.profitLoss?.value, 120_000_000)
assert.equal(automotiveSegment?.assets?.value, 2_000_000_000)
assert.equal(automotiveSegment?.depreciation?.value, 30_000_000)
assert.equal(automotiveSegment?.capitalExpenditure?.value, 50_000_000)
assert.equal(segmentInformation.segments.find((segment) => segment.name === 'Specialty')?.typedMember, true)
assert.equal(segmentInformation.segments.find((segment) => segment.kind === 'other')?.name, 'その他')
assert.equal(
  segmentInformation.segments.find((segment) => segment.kind === 'adjustment')?.name,
  '消去又は全社',
)
assert.equal(segmentInformation.geographicAreas.length, 1)
assert.equal(segmentInformation.geographicAreas[0]?.name, 'Japan')
assert.equal(segmentInformation.geographicAreas[0]?.revenue.value, 700_000_000)
assert.equal(segmentInformation.geographicAreas[0]?.source, 'structured_fact')
assert.equal(segmentInformation.majorCustomers.length, 1)
assert.equal(segmentInformation.majorCustomers[0]?.name, 'Customer A')
assert.equal(segmentInformation.majorCustomers[0]?.revenue?.value, 150_000_000)
assert.equal(segmentInformation.majorCustomers[0]?.revenueRatio?.value, 0.15)

console.log('EDINET XBRL parser tests passed')
