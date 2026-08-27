import { createHash, createHmac, randomBytes } from 'node:crypto'



const HOUSE_EDGE = 0.065
const MIN_CRASH = 1.0
const MAX_CRASH = 1000 // ceiling to avoid pathological floats on tiny hash outputs

export interface RoundSeed {
  serverSeed: string
  serverSeedHash: string // safe to publish to clients before the round starts
  roundNumber: number
  clientSeed: string
}


export function generateRoundSeed(roundNumber: number, clientSeed = 'default'): RoundSeed {
  const serverSeed = randomBytes(32).toString('hex')
  const serverSeedHash = createHash('sha256').update(serverSeed).digest('hex')
  return { serverSeed, serverSeedHash, roundNumber, clientSeed }
}


export function computeCrashPoint({ serverSeed, roundNumber, clientSeed }: RoundSeed): number {
  const message = `${clientSeed}:${roundNumber}`
  const hmac = createHmac('sha256', serverSeed).update(message).digest('hex')

  // First 52 bits (13 hex chars) as an integer -- this is the standard
  // width used across public crash-game implementations because it maps
  // cleanly onto a JS-safe integer and 2^52 buckets is far more than
  // enough resolution.
  const h = parseInt(hmac.slice(0, 13), 16)
  const E = Math.pow(2, 52)

  // Instant-crash rounds: a fixed fraction of rounds resolve at exactly
  // 1.00x. This -- not tail-capping -- is what encodes the house edge.
  // A naive "1 / (1 - r)" curve has *no finite mean* even when you clip
  // the top end, so clipping alone quietly gives away far more than
  // HOUSE_EDGE suggests.
  //
  const edgeRoll = parseInt(hmac.slice(13, 26), 16)
  const edgeThreshold = Math.floor(HOUSE_EDGE * E)
  if (edgeRoll < edgeThreshold) {
    return MIN_CRASH
  }

  const crash = Math.floor((100 * E) / (E - h)) / 100
  return Math.min(Math.max(crash, MIN_CRASH), MAX_CRASH)
}


export function verifyRound(seed: RoundSeed, claimedCrashPoint: number): boolean {
  const hashCheck = createHash('sha256').update(seed.serverSeed).digest('hex')
  if (hashCheck !== seed.serverSeedHash) return false
  const recomputed = computeCrashPoint(seed)
  return recomputed === claimedCrashPoint
}