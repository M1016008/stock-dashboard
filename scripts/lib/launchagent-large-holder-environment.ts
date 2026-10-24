import { assertLargeHolderReleaseConfiguration } from '@/lib/large-holders/release-preflight'

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function launchAgentLargeHolderEnvironmentXml(
  environment: NodeJS.ProcessEnv = process.env,
  indent = '    ',
): string {
  const verified = assertLargeHolderReleaseConfiguration(environment)
  return Object.entries(verified.environment)
    .map(([key, value]) => `${indent}<key>${key}</key><string>${xmlEscape(value)}</string>`)
    .join('\n')
}
