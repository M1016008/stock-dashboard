import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  classificationValidationOptionsFromEnv,
  readClassificationSource,
  validateClassificationSource,
} from '../lib/classification-source'

async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-classification-'))
  const sourcePath = path.join(directory, 'classification.csv')
  try {
  fs.writeFileSync(
    sourcePath,
    '\ufeff' + [
      [
        '大分類', 'コード', '業種細分類', '更新時刻',
        '予想PER（倍）', '実績PBR（倍）', '予想ROE（％）', '配当利回り（％）',
        '四季報見出し1', '四季報説明文1', '四季報見出し2', '四季報説明文2',
        '四季報号', '四季報発売日', '特色', '連結事業',
      ].join(','),
      [
        '電子部品・産業用電子機器', '6806', 'コネクター', '08/06',
        '14.25', '1.40', '9.8', '2.15',
        '増益', '主力事業が伸長', '新展開', '海外市場を開拓',
        '2026年3集夏号', '2026年6月17日', '接続部品に強み', '電子部品100',
      ].join(','),
      '総合スーパー,8273,08/06,',
      '仮分類,9999,123,08/06',
    ].join('\n'),
    'utf8',
  )

  const source = await readClassificationSource(sourcePath)
  assert.deepEqual(source.records, [
    { ticker: '6806', majorCategory: '電子部品・産業用電子機器', subIndustry: 'コネクター' },
    { ticker: '8273', majorCategory: '総合スーパー', subIndustry: '未分類' },
    { ticker: '9999', majorCategory: '仮分類', subIndustry: '123' },
  ])
  assert.deepEqual(source.recoveredMissingSubIndustries, ['8273'])
  assert.deepEqual(source.invalidSubIndustries, ['9999:123'])
  assert.deepEqual(source.profiles[0], {
    ticker: '6806',
    forecastPer: 14.25,
    actualPbr: 1.4,
    forecastRoe: 9.8,
    dividendYield: 2.15,
    headline1: '増益',
    description1: '主力事業が伸長',
    headline2: '新展開',
    description2: '海外市場を開拓',
    issueLabel: '2026年3集夏号',
    releaseDate: '2026年6月17日',
    companyFeature: '接続部品に強み',
    consolidatedBusiness: '電子部品100',
  })
  assert.equal(source.profiles[1]?.forecastPer, null)
  assert.throws(
    () => validateClassificationSource(source, {
      minRecords: 3,
      expectedMajorCategories: 3,
      minSubIndustries: 3,
      maxSkippedRows: 0,
      maxRecoveredMissingSubIndustries: 1,
      maxDuplicateTickers: 0,
    }),
    /invalidSubIndustries=1/,
  )
  assert.throws(
    () => validateClassificationSource(source, {
      minRecords: 3,
      expectedMajorCategories: 3,
      minSubIndustries: 3,
      maxSkippedRows: 0,
      maxRecoveredMissingSubIndustries: 0,
      maxDuplicateTickers: 0,
    }),
    /recoveredMissingSubIndustries=1\/0/,
  )
  const previousLimit = process.env.CLASSIFICATION_MAX_RECOVERED_MISSING_SUB_INDUSTRIES
  process.env.CLASSIFICATION_MAX_RECOVERED_MISSING_SUB_INDUSTRIES = '0'
  assert.equal(classificationValidationOptionsFromEnv().maxRecoveredMissingSubIndustries, 0)
  if (previousLimit == null) {
    delete process.env.CLASSIFICATION_MAX_RECOVERED_MISSING_SUB_INDUSTRIES
  } else {
    process.env.CLASSIFICATION_MAX_RECOVERED_MISSING_SUB_INDUSTRIES = previousLimit
  }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

main()
  .then(() => console.log('classification source normalization tests: ok'))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
