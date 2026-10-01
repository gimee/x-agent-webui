import { Server } from 'socket.io'
import type { Server as HttpServer } from 'http'
import { logger } from '../public/logging'
import { config } from '../public/config'
import { createSocketIoCorsOrigin, shouldRejectUpgradeOrigin } from '../public/security'

/**
 * Shared Socket.IO server for /chat-run, the App relay and the global-agent
 * namespaces. hermes-v0.1.2: extracted from the removed GroupChatServer so the
 * chat surfaces no longer depend on group-chat code.
 */
export function createSocketIoServer(httpServers: HttpServer | HttpServer[]): Server {
  const servers = Array.isArray(httpServers) ? httpServers : [httpServers]
  const io = new Server(servers[0], {
    cors: { origin: createSocketIoCorsOrigin(config.corsOrigins) },
    maxHttpBufferSize: 2_000_000,
    allowRequest: (req, callback) => {
      if (shouldRejectUpgradeOrigin(req, config.corsOrigins)) {
        logger.warn({
          origin: req.headers.origin || '',
          host: req.headers.host || '',
          url: req.url || '',
        }, '[Socket.IO] rejected upgrade origin')
        callback('origin not allowed', false)
        return
      }
      callback(null, true)
    },
    pingInterval: 25_000,
    pingTimeout: 90_000,
    // hermes-v050:S13 resume/history frames are 145-169KB of JSON (~50KB deflated at level 1,
    // 2.5-3ms); streaming deltas stay below the threshold and are sent uncompressed. ws only
    // honors `threshold` without server context takeover. Clients without the extension simply
    // do not negotiate it (browsers and socket.io-client do).
    perMessageDeflate: {
      threshold: 32 * 1024,
      serverNoContextTakeover: true,
      zlibDeflateOptions: { level: 1 },
    },
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60_000,
      skipMiddlewares: true,
    },
  })
  servers.slice(1).forEach((httpServer) => io.attach(httpServer))
  return io
}
