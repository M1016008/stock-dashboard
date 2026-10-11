import { createFriendReadonlyGateway, friendReadonlyGatewayOptionsFromEnvironment } from '@/lib/friend-readonly-gateway'
import {
  FRIEND_PRIVATE_PATH_PREFIXES,
  FRIEND_READ_ONLY_JSON_POST_PATHS,
} from '@/lib/friend-readonly-policy'

const options = friendReadonlyGatewayOptionsFromEnvironment()
const server = createFriendReadonlyGateway(options)

server.listen(options.port, options.host, () => {
  console.log(JSON.stringify({
    status: 'READY',
    accessMode: 'FRIEND_READ_ONLY',
    listen: `http://${options.host}:${options.port}`,
    origin: options.origin.toString(),
    allowedReadTransports: [
      'GET *',
      'HEAD *',
      ...[...FRIEND_READ_ONLY_JSON_POST_PATHS].sort().map((pathname) => `POST ${pathname}`),
    ],
    blockedPaths: FRIEND_PRIVATE_PATH_PREFIXES.map((prefix) => `${prefix}/**`),
  }))
})

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5_000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
