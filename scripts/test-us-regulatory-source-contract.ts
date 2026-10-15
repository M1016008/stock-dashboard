import assert from 'node:assert/strict'
import {
  US_OWNERSHIP_SOURCE_CONTRACT,
  US_REGULATORY_SOURCE_CONTRACT_VERSION,
  US_SHORT_INTEREST_SOURCE_CONTRACT,
  canPublishUsInstitutionalOwnership,
  canPublishUsShortInterest,
} from '@/lib/us-regulatory-source-contract'

assert.equal(US_REGULATORY_SOURCE_CONTRACT_VERSION, 'us-regulatory-source-v1')
assert.notEqual(
  US_OWNERSHIP_SOURCE_CONTRACT.institutionalManagerPositions.ownershipMeaning,
  US_OWNERSHIP_SOURCE_CONTRACT.significantBeneficialOwners.ownershipMeaning,
  '13F positions and 13D/G beneficial ownership must remain separate metrics',
)
assert.equal(US_OWNERSHIP_SOURCE_CONTRACT.institutionalManagerPositions.issuerIdentifier, 'CUSIP')
assert.equal(US_OWNERSHIP_SOURCE_CONTRACT.significantBeneficialOwners.issuerIdentifier, 'CIK')
assert.equal(US_SHORT_INTEREST_SOURCE_CONTRACT.exclusions.finraPublicApi, 'OTC_ONLY_NOT_CURRENT_UNIVERSE')
assert.equal(US_SHORT_INTEREST_SOURCE_CONTRACT.exclusions.dailyShortSaleVolume, 'DIFFERENT_METRIC_NOT_SHORT_INTEREST')
assert.equal(canPublishUsInstitutionalOwnership(), false)
assert.equal(canPublishUsShortInterest(), false)
console.log('US regulatory source contracts fail closed and preserve metric identity')
