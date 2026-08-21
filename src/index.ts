import { createServer } from 'node:http'
import { tick } from './round-manager.js'
import { createGameWsServer } from './ws-server.js'

const TICK_MS = 250
const PORT = Number(process.env.PORT ?? 8080)

let inFlight = false
let stopping = false

async function loop() {
  if (inFlight || stopping) return
  inFlight = true
  try {
    await tick()
  } catch (err) {
    console.error('[ticker] tick() failed:', err)
  } finally {
    inFlight = false
  }
}

// The WS server attaches to a plain HTTP server rather than opening its
// own port -- Railway routes public traffic to whatever this process
// listens on, so it also doubles as a health check target.
const httpServer = createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }
  res.writeHead(404)
  res.end()
})

createGameWsServer(httpServer)

httpServer.listen(PORT, () => {
  console.log(`[ticker] http/ws server listening on :${PORT}`)
})

console.log(`[ticker] starting, interval ${TICK_MS}ms`)
const handle = setInterval(loop, TICK_MS)
loop() // fire immediately instead of waiting the first interval

function shutdown() {
  console.log('[ticker] shutting down')
  stopping = true
  clearInterval(handle)
  httpServer.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2_000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)