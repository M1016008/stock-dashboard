export type FreshnessReportStatus = 'ok' | 'attention' | 'unavailable'

export type FreshnessMonitoringAssessment = {
  status: 'PASS' | 'ATTENTION' | 'UNAVAILABLE' | 'PENDING_SCHEDULED_CHECK'
  reportStatus: FreshnessReportStatus | null
  checkedAt: string | null
  reportIsPostRecovery: boolean
  operatorFollowUpRequired: boolean
}

export type FreshnessScheduleEvidence = {
  runAtLoad: boolean
  startIntervalSeconds: number | null
  startCalendarIntervalCount: number
  reportPersistenceEnabled: boolean
  postRecoveryReportGuaranteedWithinWait: boolean
}

export function assessFreshnessSchedule(input: {
  runAtLoad: boolean
  startIntervalSeconds: number | null
  startCalendarIntervalCount: number
  reportPersistenceEnabled: boolean
  waitBudgetMs: number
}): FreshnessScheduleEvidence {
  const intervalGuaranteesReport = input.startIntervalSeconds != null
    && input.reportPersistenceEnabled
    && input.startIntervalSeconds * 1_000 <= input.waitBudgetMs
  return {
    runAtLoad: input.runAtLoad,
    startIntervalSeconds: input.startIntervalSeconds,
    startCalendarIntervalCount: input.startCalendarIntervalCount,
    reportPersistenceEnabled: input.reportPersistenceEnabled,
    // RunAtLoad may occur before all writers are restored, and a calendar schedule
    // cannot guarantee a run within an arbitrary recovery window.
    postRecoveryReportGuaranteedWithinWait: intervalGuaranteesReport,
  }
}

export function assessFreshnessMonitoring(input: {
  report: unknown
  reportMtimeMs: number | null
  recoveryCompletedAtMs: number
}): FreshnessMonitoringAssessment {
  if (!input.report || typeof input.report !== 'object') {
    return {
      status: 'PENDING_SCHEDULED_CHECK',
      reportStatus: null,
      checkedAt: null,
      reportIsPostRecovery: false,
      operatorFollowUpRequired: true,
    }
  }
  const candidate = input.report as { status?: unknown; checkedAt?: unknown }
  const reportStatus = candidate.status === 'ok'
    || candidate.status === 'attention'
    || candidate.status === 'unavailable'
    ? candidate.status
    : null
  const checkedAt = typeof candidate.checkedAt === 'string' ? candidate.checkedAt : null
  const checkedAtMs = checkedAt == null ? Number.NaN : Date.parse(checkedAt)
  const reportIsPostRecovery = reportStatus != null
    && Number.isFinite(checkedAtMs)
    && input.reportMtimeMs != null
    && checkedAtMs >= input.recoveryCompletedAtMs
    && input.reportMtimeMs >= input.recoveryCompletedAtMs
  if (!reportIsPostRecovery) {
    return {
      status: 'PENDING_SCHEDULED_CHECK',
      reportStatus,
      checkedAt,
      reportIsPostRecovery: false,
      operatorFollowUpRequired: true,
    }
  }
  if (reportStatus === 'ok') {
    return {
      status: 'PASS',
      reportStatus,
      checkedAt,
      reportIsPostRecovery: true,
      operatorFollowUpRequired: false,
    }
  }
  return {
    status: reportStatus === 'attention' ? 'ATTENTION' : 'UNAVAILABLE',
    reportStatus,
    checkedAt,
    reportIsPostRecovery: true,
    operatorFollowUpRequired: true,
  }
}

export type CloudflareAccessEvidence = {
  version: 1
  capturedAt: string
  expiresAt: string
  hostname: string
  teamDomain: string
  applicationId: string
  applicationAudience: string
  applicationType: 'SELF_HOSTED'
  policyId: string
  policyName: string
  policyAction: 'ALLOW'
  bypassPolicyCount: 0
  allowedIdentityCount: number
  allowedIdentitiesSha256: string
  authenticationMethod: 'ONE_TIME_PIN'
  tunnelId: string
  tunnelHostname: 'stock.marketframe.jp'
  tunnelOrigin: 'http://127.0.0.1:3136'
  tunnelFallback: 'http_status:404'
  tunnelWarpRoutingEnabled: false
}

export function assertCloudflareAccessEvidence(evidence: CloudflareAccessEvidence, now = Date.now()): void {
  const capturedAt = Date.parse(evidence.capturedAt)
  const expiresAt = Date.parse(evidence.expiresAt)
  if (evidence.version !== 1
    || !Number.isFinite(capturedAt) || !Number.isFinite(expiresAt)
    || capturedAt > now || expiresAt <= now || expiresAt <= capturedAt
    || evidence.hostname !== 'stock.marketframe.jp'
    || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(evidence.teamDomain)
    || !/^[0-9a-f-]{36}$/.test(evidence.applicationId)
    || !/^[0-9a-f]{64}$/.test(evidence.applicationAudience)
    || evidence.applicationType !== 'SELF_HOSTED'
    || !/^[0-9a-f-]{36}$/.test(evidence.policyId)
    || evidence.policyName !== 'Allow StockBoard Friend'
    || evidence.policyAction !== 'ALLOW' || evidence.bypassPolicyCount !== 0
    || evidence.allowedIdentityCount !== 2
    || !/^[0-9a-f]{64}$/.test(evidence.allowedIdentitiesSha256)
    || evidence.authenticationMethod !== 'ONE_TIME_PIN'
    || !/^[0-9a-f-]{36}$/.test(evidence.tunnelId)
    || evidence.tunnelHostname !== evidence.hostname
    || evidence.tunnelOrigin !== 'http://127.0.0.1:3136'
    || evidence.tunnelFallback !== 'http_status:404'
    || evidence.tunnelWarpRoutingEnabled !== false) {
    throw new Error('rollback_finalization_cloudflare_access_evidence_invalid')
  }
}

export function assertCloudflareAccessChallenge(input: {
  evidence: CloudflareAccessEvidence
  status: number
  location: string | null
  wwwAuthenticate: string | null
  loginBody: string
}): void {
  const { evidence } = input
  let location: URL
  try {
    location = new URL(input.location ?? '')
  } catch {
    throw new Error('rollback_finalization_cloudflare_access_location_invalid')
  }
  if (input.status !== 302
    || location.protocol !== 'https:'
    || location.hostname !== evidence.teamDomain
    || !location.pathname.startsWith(`/cdn-cgi/access/login/${evidence.hostname}`)
    || location.searchParams.get('kid') !== evidence.applicationAudience
    || !input.wwwAuthenticate?.includes('Cloudflare-Access')
    || !input.loginBody.includes('verify-code')
    || !input.loginBody.includes('Send login code')) {
    throw new Error('rollback_finalization_cloudflare_access_boundary_invalid')
  }
}
