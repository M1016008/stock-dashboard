import fs from 'node:fs'
import path from 'node:path'
import {
  assertWeeklyBackupPlanSha256,
  assertWeeklyBackupPreflight,
  availableCandidateGrowthBytes,
  validateWeeklyBackupPlan,
  type WeeklyBackupObservation,
  type WeeklyBackupPlan,
} from '@/lib/storage/weekly-backup-policy'

const values = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split('=')
  return [key, rest.join('=')]
}))
const planPath = values.get('--plan')
const observationPath = values.get('--observation')
const expectedPlanSha256 = values.get('--expected-plan-sha256')
if (!planPath || !observationPath || !expectedPlanSha256) {
  throw new Error('usage: npm run backup:weekly:preflight -- --plan=/absolute/plan.json --observation=/absolute/observation.json --expected-plan-sha256=<approved-sha256>')
}
if (!path.isAbsolute(planPath) || !path.isAbsolute(observationPath)) throw new Error('ABSOLUTE_INPUT_PATH_REQUIRED')
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8')) as WeeklyBackupPlan
const observation = JSON.parse(fs.readFileSync(observationPath, 'utf8')) as WeeklyBackupObservation
validateWeeklyBackupPlan(plan)
const planSha256 = assertWeeklyBackupPlanSha256(plan, expectedPlanSha256)
assertWeeklyBackupPreflight(plan, observation)
console.log(JSON.stringify({
  verdict: 'PASS',
  planSha256,
  runId: plan.runId,
  availableCandidateGrowthBytes: availableCandidateGrowthBytes(plan, observation.destinationFreeBytes),
  productionDatabaseOpened: false,
  destinationWritten: false,
  writerHoldApplied: false,
  readyForSeparateExecutionApproval: true,
}, null, 2))
