import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  classificationValidationOptionsFromEnv,
  readClassificationSource,
  validateClassificationSource,
} from '../lib/classification-source'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-classification-'))
const sourcePath = path.join(directory, 'classification.csv')

try {
  fs.writeFileSync(
    sourcePath,
    '\ufeff' + [
      '大分類,コード,業種細分類,更新時刻',
      '電子部品・産業用電子機器,6806,コネクター,08/06',
      '総合スーパー,8273,08/06,',
      '仮分類,9999,123,08/06',
    ].join('\n'),
    'utf8',
  )

  const source = readClassificationSource(sourcePath)
  assert.deepEqual(source.records, [
    { ticker: '6806', majorCategory: '電子部品・産業用電子機器', subIndustry: 'コネクター' },
    { ticker: '8273', majorCategory: '総合スーパー', subIndustry: '未分類' },
    { ticker: '9999', majorCategory: '仮分類', subIndustry: '123' },
  ])
  assert.deepEqual(source.recoveredMissingSubIndustries, ['8273'])
  assert.deepEqual(source.invalidSubIndustries, ['9999:123'])
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

console.log('classification source normalization tests: ok')
