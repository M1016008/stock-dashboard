import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEnvConfig } from '@next/env'

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'stockboard-env-parser-'))
  const marker = join(dir, 'executed')
  try {
    const envFile = join(dir, '.env.local')
    await writeFile(envFile, [
      `SHELL_SUBSTITUTION="$(touch ${marker})"`,
      `BACKTICK_VALUE='\`touch ${marker}\`'`,
      'QUOTED_SPACES="two words"',
      'SINGLE_QUOTED=\'three words\'',
      'SHELL_METACHARACTERS="a;b|c&d>e"',
      'LITERAL_TEXT=ordinary-value',
      '',
    ].join('\n'))
    const loaded = loadEnvConfig(dir)
    assert.equal(existsSync(marker), false)
    assert.equal(process.env.SHELL_SUBSTITUTION, `$(touch ${marker})`)
    assert.equal(process.env.BACKTICK_VALUE, `\`touch ${marker}\``)
    assert.equal(process.env.QUOTED_SPACES, 'two words')
    assert.equal(process.env.SINGLE_QUOTED, 'three words')
    assert.equal(process.env.SHELL_METACHARACTERS, 'a;b|c&d>e')
    assert.ok(loaded.loadedEnvFiles.some((file) => file.path === '.env.local'))

    const child = spawnSync(process.execPath, [
      `--env-file=${envFile}`, '-e',
      'if (process.env.LITERAL_TEXT !== "ordinary-value") process.exit(1)',
    ], { encoding: 'utf8', env: { ...process.env } })
    assert.equal(child.status, 0, child.stderr)
    assert.equal(existsSync(marker), false)
    console.log('env file non-execution: PASS')
  } finally {
    for (const key of ['SHELL_SUBSTITUTION', 'BACKTICK_VALUE', 'QUOTED_SPACES', 'SHELL_METACHARACTERS',
      'SINGLE_QUOTED', 'LITERAL_TEXT']) delete process.env[key]
    await rm(dir, { recursive: true, force: true })
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1 })
