import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
const installer = fs.readFileSync(path.join(root, 'scripts/install-local-web-server.ts'), 'utf8')
const remote = fs.readFileSync(path.join(root, 'scripts/manage-tailscale-remote-access.ts'), 'utf8')

assert.match(pkg.scripts.dev, /-H 127\.0\.0\.1/)
assert.match(pkg.scripts['dev:3000'], /-H 127\.0\.0\.1/)
assert.match(pkg.scripts['share:start'], /-H 127\.0\.0\.1/)
assert.match(installer, /const host = '127\.0\.0\.1'/)
assert.match(installer, /<string>-H<\/string>/)
assert.match(installer, /<string>\$\{host\}<\/string>/)
assert.match(remote, /\['serve', '--bg', '--yes', '--https=443', '--set-path=\/', target\]/)
assert.match(remote, /\['serve', '--yes', '--https=443', '--set-path=\/', 'off'\]/)
assert.match(remote, /const target = `127\.0\.0\.1:\$\{port\}`/)
assert.match(remote, /timeout: 15_000/)
assert.match(remote, /error\.code === 'ETIMEDOUT'/)
assert.match(remote, /if \(!serveTargetsLocalApp\(currentServe\)\)/)
assert.doesNotMatch(remote, /\['serve', 'reset'\]/)
assert.doesNotMatch(remote, /\bfunnel\b/)
assert.doesNotMatch(remote, /auth-key/)

console.log('remote access safety tests passed')
