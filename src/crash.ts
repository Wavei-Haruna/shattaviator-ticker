import { createHash, createHmac, randomBytes } from 'node:crypto'

const HOUSE_EDGE = 0.065
const MIN_CRASH = 1.0
const MAX_CRASH = 1000
const HASH_HEX_CHARS = 13
const HASH_BITS = 52

export interface RoundSeed {
  serverSeed: string
  serverSeedHash: string
  roundNumber: number
  clientSeed: string
}

export function generateRoundSeed(
  roundNumber: number,
  clientSeed = 'default',
): RoundSeed {
  const serverSeed = randomBytes(32).toString('hex')

  const serverSeedHash = createHash('sha256')
    .update(serverSeed)
    .digest('hex')

  return {
    serverSeed,
    serverSeedHash,
    roundNumber,
    clientSeed,
  }
}

export function computeCrashPoint({
  serverSeed,
  roundNumber,
  clientSeed,
}: RoundSeed): number {
  const message = `${clientSeed}:${roundNumber}`

  const hmac = createHmac('sha256', serverSeed)
    .update(message)
    .digest('hex')

  const E = 2 ** HASH_BITS

  // First 52 bits determine the crash distribution.
  const h = parseInt(
    hmac.slice(0, HASH_HEX_CHARS),
    16,
  )

  // Independent portion of the HMAC determines
  // whether this round is an instant 1.00x crash.
  const edgeRoll = parseInt(
    hmac.slice(HASH_HEX_CHARS, HASH_HEX_CHARS * 2),
    16,
  )

  const edgeThreshold = Math.floor(HOUSE_EDGE * E)

  if (edgeRoll < edgeThreshold) {
    return MIN_CRASH
  }

  const crash =
    Math.floor((100 * E) / (E - h)) / 100

  return Math.min(
    Math.max(crash, MIN_CRASH),
    MAX_CRASH,
  )
}

export function verifyRound(
  seed: RoundSeed,
  claimedCrashPoint: number,
): boolean {
  const hashCheck = createHash('sha256')
    .update(seed.serverSeed)
    .digest('hex')

  if (hashCheck !== seed.serverSeedHash) {
    return false
  }

  const recomputed = computeCrashPoint(seed)

  return recomputed === claimedCrashPoint
}