import fs from 'node:fs'

const scenarioPath = process.env.JP_OHLCV_PROCESS_E2E_PROVIDER_SCENARIO
if (!scenarioPath) throw new Error('JP_OHLCV_PROCESS_E2E_PROVIDER_SCENARIO is required')

globalThis.fetch = async (input) => {
  const url = String(input)
  if (!url.startsWith('https://api.jquants.com/v2/equities/bars/daily?')) {
    throw new Error(`unexpected_process_e2e_fetch:${url}`)
  }
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'))
  if (scenario.waitMarker) {
    fs.writeFileSync(scenario.waitMarker, 'provider-requested')
    const deadline = Date.now() + Number(scenario.waitTimeoutMs ?? 10_000)
    while (!fs.existsSync(scenario.releaseMarker)) {
      if (Date.now() >= deadline) throw new Error('process_e2e_provider_release_timeout')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  if (scenario.status && scenario.status !== 200) {
    return new Response(JSON.stringify({ error: 'fixture-provider-failure' }), {
      status: scenario.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response(JSON.stringify({ data: scenario.rows ?? [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
