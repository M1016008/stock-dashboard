import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import {
  assessFreshnessMonitoring,
  assessFreshnessSchedule,
  assertCloudflareAccessChallenge,
  assertCloudflareAccessEvidence,
  type CloudflareAccessEvidence,
} from '@/lib/rollback-finalization-monitoring'
import {
  completeInterruptedRollbackArchive,
  repairApprovalSha256,
  repairRollbackFinalizationApprovalSha256,
  repairRollbackFinalizationContinuationApprovalSha256,
  type JpOhlcvRepairApproval,
  type JpOhlcvRepairJournal,
  type JpOhlcvRollbackFinalizationApproval,
  type JpOhlcvRollbackFinalizationContinuationApproval,
} from '@/lib/jp-ohlcv-production-repair'
import { runJpOhlcvProductionRepairRollbackFinalization } from '@/lib/jp-ohlcv-repair-runner'

function fileSha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function write(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function main(): Promise<void> {
  const recoveryCompletedAtMs = Date.parse('2026-10-31T01:00:00.000Z')
  assert.equal(assessFreshnessSchedule({
    runAtLoad: false,
    startIntervalSeconds: 900,
    startCalendarIntervalCount: 0,
    reportPersistenceEnabled: true,
    waitBudgetMs: 300_000,
  }).postRecoveryReportGuaranteedWithinWait, false)
  assert.equal(assessFreshnessSchedule({
    runAtLoad: false,
    startIntervalSeconds: null,
    startCalendarIntervalCount: 18,
    reportPersistenceEnabled: true,
    waitBudgetMs: 300_000,
  }).postRecoveryReportGuaranteedWithinWait, false)
  assert.equal(assessFreshnessSchedule({
    runAtLoad: true,
    startIntervalSeconds: 60,
    startCalendarIntervalCount: 0,
    reportPersistenceEnabled: true,
    waitBudgetMs: 300_000,
  }).postRecoveryReportGuaranteedWithinWait, true)
  assert.equal(assessFreshnessSchedule({
    runAtLoad: true,
    startIntervalSeconds: 60,
    startCalendarIntervalCount: 0,
    reportPersistenceEnabled: false,
    waitBudgetMs: 300_000,
  }).postRecoveryReportGuaranteedWithinWait, false)
  assert.equal(assessFreshnessSchedule({
    runAtLoad: false,
    startIntervalSeconds: null,
    startCalendarIntervalCount: 0,
    reportPersistenceEnabled: false,
    waitBudgetMs: 300_000,
  }).postRecoveryReportGuaranteedWithinWait, false)
  assert.equal(assessFreshnessMonitoring({
    report: { status: 'ok', checkedAt: '2026-10-31T01:01:00.000Z' },
    reportMtimeMs: recoveryCompletedAtMs + 60_000,
    recoveryCompletedAtMs,
  }).status, 'PASS')
  assert.equal(assessFreshnessMonitoring({
    report: { status: 'attention', checkedAt: '2026-10-31T01:01:00.000Z' },
    reportMtimeMs: recoveryCompletedAtMs + 60_000,
    recoveryCompletedAtMs,
  }).status, 'ATTENTION')
  assert.equal(assessFreshnessMonitoring({
    report: { status: 'unavailable', checkedAt: '2026-10-31T01:01:00.000Z' },
    reportMtimeMs: recoveryCompletedAtMs + 60_000,
    recoveryCompletedAtMs,
  }).status, 'UNAVAILABLE')
  assert.equal(assessFreshnessMonitoring({
    report: { status: 'ok', checkedAt: '2026-10-31T00:59:00.000Z' },
    reportMtimeMs: recoveryCompletedAtMs - 60_000,
    recoveryCompletedAtMs,
  }).status, 'PENDING_SCHEDULED_CHECK')
  assert.equal(assessFreshnessMonitoring({
    report: null,
    reportMtimeMs: null,
    recoveryCompletedAtMs,
  }).status, 'PENDING_SCHEDULED_CHECK')
  const accessEvidence: CloudflareAccessEvidence = {
    version: 1,
    capturedAt: '2026-10-31T00:00:00.000Z',
    expiresAt: '2026-11-01T00:00:00.000Z',
    hostname: 'stock.marketframe.jp',
    teamDomain: 'lingering-credit-876f.cloudflareaccess.com',
    applicationId: '71c9b27f-812c-43a2-91ac-2d7912bbd674',
    applicationAudience: '5de8100db079acab3f2c2b7cdca933ae6093d726011942632098bd3f2b96e324',
    applicationType: 'SELF_HOSTED',
    policyId: 'a33fd2fa-cad0-46e3-8f73-c5e025ea425e',
    policyName: 'Allow StockBoard Friend',
    policyAction: 'ALLOW',
    bypassPolicyCount: 0,
    allowedIdentityCount: 2,
    allowedIdentitiesSha256: 'c0307ac95554a0be26cee2ea45075244342f86844dee5b0bc847198f89fa9cca',
    authenticationMethod: 'ONE_TIME_PIN',
    tunnelId: '13b88266-b902-43b4-aadb-0c325baff9b3',
    tunnelHostname: 'stock.marketframe.jp',
    tunnelOrigin: 'http://127.0.0.1:3136',
    tunnelFallback: 'http_status:404',
    tunnelWarpRoutingEnabled: false,
  }
  assert.doesNotThrow(() => assertCloudflareAccessEvidence(
    accessEvidence,
    Date.parse('2026-10-31T12:00:00.000Z'),
  ))
  assert.throws(() => assertCloudflareAccessEvidence(
    { ...accessEvidence, bypassPolicyCount: 1 as 0 },
    Date.parse('2026-10-31T12:00:00.000Z'),
  ), /cloudflare_access_evidence_invalid/)
  assert.throws(() => assertCloudflareAccessEvidence(
    accessEvidence,
    Date.parse('2026-11-02T00:00:00.000Z'),
  ), /cloudflare_access_evidence_invalid/)
  assert.doesNotThrow(() => assertCloudflareAccessChallenge({
    evidence: accessEvidence,
    status: 302,
    location: `https://${accessEvidence.teamDomain}/cdn-cgi/access/login/stock.marketframe.jp?kid=${accessEvidence.applicationAudience}`,
    wwwAuthenticate: 'Cloudflare-Access',
    loginBody: '<form id="verify-code">Send login code</form>',
  }))
  assert.throws(() => assertCloudflareAccessChallenge({
    evidence: accessEvidence,
    status: 302,
    location: `https://${accessEvidence.teamDomain}/cdn-cgi/access/login/stock.marketframe.jp?kid=${'f'.repeat(64)}`,
    wwwAuthenticate: 'Cloudflare-Access',
    loginBody: '<form id="verify-code">Send login code</form>',
  }), /cloudflare_access_boundary_invalid/)
  assert.throws(() => assertCloudflareAccessChallenge({
    evidence: accessEvidence,
    status: 302,
    location: `https://example.com/cdn-cgi/access/login/stock.marketframe.jp?kid=${accessEvidence.applicationAudience}`,
    wwwAuthenticate: 'Cloudflare-Access',
    loginBody: '<form id="verify-code">Send login code</form>',
  }), /cloudflare_access_boundary_invalid/)
  assert.throws(() => assertCloudflareAccessChallenge({
    evidence: accessEvidence,
    status: 302,
    location: `https://${accessEvidence.teamDomain}/cdn-cgi/access/login/stock.marketframe.jp?kid=${accessEvidence.applicationAudience}`,
    wwwAuthenticate: 'Cloudflare-Access',
    loginBody: '<form>single sign-on only</form>',
  }), /cloudflare_access_boundary_invalid/)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-rollback-finalization-'))
  try {
    const paths = {
      stateDirectory: root,
      journal: path.join(root, 'repair-journal.json'),
      lock: path.join(root, 'repair.lock'),
    }
    const database = path.join(root, 'stockboard.db')
    fs.writeFileSync(database, 'restored database fixture')
    const backupSha256 = fileSha256(database)
    const sourceGeneration = 'jp-source-pre-fixture'
    const servingGeneration = 'jp-serving-pre-fixture'
    const transactionId = 'fixture-rollback-finalization'
    const approval: JpOhlcvRepairApproval = {
      version: 1,
      executionScope: 'ISOLATED_FIXTURE',
      targetDate: '2026-07-17',
      officialSha256: '1'.repeat(64),
      planSha256: '2'.repeat(64),
      missingRowsSha256: '3'.repeat(64),
      approvedRepairKeysSha256: '4'.repeat(64),
      runtimeDriftPolicy: 'ALLOW_APPROVED_KEYS_TO_BECOME_EXACT_MATCH_ONLY',
      runtimeSnapshotTtlMs: 900000,
      officialSourceContract: {} as JpOhlcvRepairApproval['officialSourceContract'],
      preservedConflictsSha256: '5'.repeat(64),
      expectedOfficialRows: 4218,
      expectedExistingRows: 157,
      expectedMatchingRows: 155,
      expectedMissingRows: 4061,
      approvedConflictTickers: ['1447', '2164'],
      conflictDisposition: 'PRESERVE_EXISTING_HOLD',
      databaseRealpath: database,
      databaseIdentitySha256: '6'.repeat(64),
      stateDirectory: root,
      backupDirectory: root,
      sourceGenerationBefore: sourceGeneration,
      sourceGenerationAfter: 'jp-source-repair-fixture',
      servingGenerationBefore: servingGeneration,
      servingGenerationAfter: 'jp-serving-repair-fixture',
      derivedPlanSha256: '7'.repeat(64),
    }
    const approvalSha256 = repairApprovalSha256(approval)
    const journal: JpOhlcvRepairJournal = {
      version: 1,
      transactionId,
      stage: 'HOLD',
      createdAt: '2026-10-31T00:00:00.000Z',
      updatedAt: '2026-10-31T01:00:00.000Z',
      approvalSha256,
      targetDate: approval.targetDate,
      databaseRealpath: database,
      backupDirectory: root,
      sourceGeneration: { before: sourceGeneration, after: approval.sourceGenerationAfter },
      servingGeneration: { before: servingGeneration, after: approval.servingGenerationAfter },
      protectedPaths: [database, paths.journal, paths.lock],
      preservedConflicts: {
        tickers: ['1447', '2164'],
        sha256: approval.preservedConflictsSha256,
        disposition: 'PRESERVE_EXISTING_HOLD',
      },
      automaticRetryAllowed: false,
      operatorAction: 'fixture hold',
      evidence: {
        ROLLBACK_DATA_RESTORED: {
          databaseRealpath: database,
          databaseSha256: backupSha256,
          sourceGeneration,
        },
        ROLLBACK_DERIVED_REBUILT: {
          sourceGeneration,
          servingGeneration,
          rebuilt: ['fixture'],
        },
        ROLLBACK_SERVING_VERIFIED: {
          sourceGeneration,
          servingGeneration,
          health: 'PASS',
        },
      },
      failure: {
        name: 'Error',
        message: 'startup race',
        originalStage: 'ROLLBACK_READ_SERVICES_RESUMING',
        causes: [{ name: 'Error', message: 'connection refused' }],
      },
    }
    write(paths.journal, journal)
    write(paths.lock, {
      transactionId,
      pid: 999999,
      processGroupId: 999999,
      processIdentitySha256: '8'.repeat(64),
      startedAt: '2026-10-31T00:00:00.000Z',
    })
    const restoreStatePath = path.join(root, `rollback-restore-${transactionId}.json`)
    const restoreState = { version: 1, transactionId, backupSha256, phase: 'COMPLETED' }
    write(restoreStatePath, restoreState)
    const snapshotPath = path.join(root, 'read-services.json')
    write(snapshotPath, { version: 1, transactionId, configurationSha256: '9'.repeat(64), services: [] })
    const finalization: JpOhlcvRollbackFinalizationApproval = {
      version: 1,
      action: 'FINALIZE_RESTORED_ROLLBACK',
      repairApprovalSha256: approvalSha256,
      transactionId,
      journalSha256: stableSha256(journal),
      journalFileSha256: fileSha256(paths.journal),
      lockFileSha256: fileSha256(paths.lock),
      restoreStatePath,
      restoreStateSha256: stableSha256(restoreState),
      restoreStateFileSha256: fileSha256(restoreStatePath),
      backupSha256,
      sourceGeneration,
      servingGeneration,
      expectedRestoredTargetRows: 157,
      preservedConflictsSha256: approval.preservedConflictsSha256,
      readServiceSnapshotPath: snapshotPath,
      readServiceSnapshotFileSha256: fileSha256(snapshotPath),
      originalReadServiceConfigurationSha256: '9'.repeat(64),
      finalizationPlanSha256: '2'.repeat(64),
      gatewayMigration: {
        label: 'com.stockboard.friend-readonly-gateway',
        plistPath: path.join(root, 'gateway.plist'),
        oldPlistSha256: 'a'.repeat(64),
        newPlistSha256: 'b'.repeat(64),
        runtimeSourcePath: path.join(root, 'gateway.mjs'),
        runtimeTargetPath: path.join(root, 'runtime', 'gateway.mjs'),
        runtimeSha256: 'c'.repeat(64),
        manifestPath: path.join(root, 'manifest.json'),
        manifestSha256: 'd'.repeat(64),
        nodeExecutable: process.execPath,
        nodeExecutableSha256: fileSha256(process.execPath),
        listen: 'http://127.0.0.1:3136',
        origin: 'http://127.0.0.1:3000',
      },
      originalRunnerRecovery: {
        pid: 999999,
        processGroupId: 999999,
        processIdentitySha256: '8'.repeat(64),
        observedState: 'PID_ABSENT',
        confirmedStoppedAt: new Date().toISOString(),
        reason: 'fixture owner absent',
      },
    }
    const result = await runJpOhlcvProductionRepairRollbackFinalization({
      approval,
      approvalSha256,
      finalizationApproval: finalization,
      finalizationApprovalSha256: repairRollbackFinalizationApprovalSha256(finalization),
      paths,
      readServicesEvidence: { web: 'PASS', analog: 'PASS', gateway: 'PASS' },
    })
    assert.equal(result.status, 'ROLLED_BACK')
    assert.equal(fs.existsSync(paths.journal), false)
    assert.equal(fs.existsSync(paths.lock), false)
    const archived = JSON.parse(fs.readFileSync(result.archivedJournal, 'utf8')) as JpOhlcvRepairJournal
    assert.equal(archived.stage, 'ROLLED_BACK')
    assert.equal(archived.evidence.ROLLBACK_READ_SERVICES_RESUMED !== undefined, true)
    fs.rmSync(result.archivedJournal)

    const interruptedStageJournal: JpOhlcvRepairJournal = {
      ...journal,
      stage: 'ROLLBACK_READ_SERVICES_RESUMED',
      failure: undefined,
      evidence: {
        ...journal.evidence,
        ROLLBACK_READ_SERVICES_RESUMING: {
          finalizationApprovalSha256: repairRollbackFinalizationApprovalSha256(finalization),
        },
        ROLLBACK_READ_SERVICES_RESUMED: { web: 'PASS', analog: 'PASS', gateway: 'PASS' },
      },
    }
    write(paths.journal, interruptedStageJournal)
    write(paths.lock, { transactionId, pid: 999999, processGroupId: 999999,
      processIdentitySha256: '8'.repeat(64), startedAt: '2026-10-31T00:00:00.000Z' })
    const writerRecoveryStateSha256 = 'e'.repeat(64)
    const continuation: JpOhlcvRollbackFinalizationContinuationApproval = {
      version: 1,
      action: 'CONTINUE_ROLLBACK_FINALIZATION',
      repairApprovalSha256: approvalSha256,
      finalizationApprovalSha256: repairRollbackFinalizationApprovalSha256(finalization),
      transactionId,
      journalSha256: stableSha256(interruptedStageJournal),
      journalFileSha256: fileSha256(paths.journal),
      lockFileSha256: fileSha256(paths.lock),
      writerRecoveryStateSha256,
      stage: 'ROLLBACK_READ_SERVICES_RESUMED',
    }
    const continued = await runJpOhlcvProductionRepairRollbackFinalization({
      approval,
      approvalSha256,
      finalizationApproval: finalization,
      finalizationApprovalSha256: repairRollbackFinalizationApprovalSha256(finalization),
      continuationApproval: continuation,
      continuationApprovalSha256: repairRollbackFinalizationContinuationApprovalSha256(continuation),
      continuationWriterRecoveryStateSha256: writerRecoveryStateSha256,
      paths,
      readServicesEvidence: { continued: true },
    })
    assert.equal(continued.status, 'ROLLED_BACK')
    fs.rmSync(continued.archivedJournal)

    write(paths.journal, journal)
    write(paths.lock, { transactionId, pid: 999999, processGroupId: 999999,
      processIdentitySha256: '8'.repeat(64), startedAt: '2026-10-31T00:00:00.000Z' })
    const tampered = { ...finalization, journalSha256: 'f'.repeat(64) }
    await assert.rejects(runJpOhlcvProductionRepairRollbackFinalization({
      approval,
      approvalSha256,
      finalizationApproval: tampered,
      finalizationApprovalSha256: repairRollbackFinalizationApprovalSha256(tampered),
      paths,
      readServicesEvidence: {},
    }), /repair_rollback_finalization_state_mismatch/)
    const interruptedPaths = {
      stateDirectory: root,
      journal: path.join(root, 'interrupted-journal.json'),
      lock: path.join(root, 'interrupted.lock'),
    }
    const finalizationApprovalSha256 = repairRollbackFinalizationApprovalSha256(finalization)
    const interruptedJournal: JpOhlcvRepairJournal = {
      ...archived,
      transactionId: `${transactionId}-interrupted`,
      evidence: {
        ...archived.evidence,
        ROLLBACK_VERIFIED: { finalizationApprovalSha256 },
      },
    }
    write(interruptedPaths.journal, interruptedJournal)
    write(interruptedPaths.lock, { transactionId: interruptedJournal.transactionId })
    const interruptedLockSha256 = fileSha256(interruptedPaths.lock)
    const interruptedArchive = completeInterruptedRollbackArchive({
      paths: interruptedPaths,
      transactionId: interruptedJournal.transactionId,
      repairApprovalSha256: approvalSha256,
      finalizationApprovalSha256,
      expectedLockFileSha256: interruptedLockSha256,
    })
    assert.equal(fs.existsSync(interruptedPaths.journal), false)
    assert.equal(fs.existsSync(interruptedPaths.lock), false)
    assert.equal(fs.existsSync(interruptedArchive), true)
    console.log('JP OHLCV rollback finalization regression: PASS (freshness contract, access boundary, terminal transition, interrupted archive, tamper rejection)')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

void main()
