import { tick } from './round-manager.js'

const TICK_MS = 250

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

console.log(`[ticker] starting, interval ${TICK_MS}ms`)
const handle = setInterval(loop, TICK_MS)
loop() // fire immediately instead of waiting the first interval

function shutdown() {
  console.log('[ticker] shutting down')
  stopping = true
  clearInterval(handle)
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)