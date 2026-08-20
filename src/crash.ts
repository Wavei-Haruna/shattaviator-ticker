import { createHash, createHmac, randomBytes } from 'node:crypto'

/**
 * Provably-fair crash point generation.
 *
 * How it works:
 * 1. Before a round, the server generates a `serverSeed` and commits to it
 *    by publishing `sha256(serverSeed)` (the "hash") to players BEFORE the
 *    round starts. Players can't know the seed, but can verify it later.
 * 2. The round is combined with a public, incrementing `roundNumber` (and
 *    optionally a player-supplied `clientSeed`) so no one -- including the
 *    operator -- can cherry-pick a favorable seed after bets are placed.
 * 3. After the round ends, the server reveals `serverSeed`. Anyone can
 *    recompute the crash point from (serverSeed, roundNumber, clientSeed)
 *    and confirm it matches what was shown live. "Provably fair" means
 *    proving the outcome wasn't changed after seeing bets -- not that any
 *    individual round is favorable to the player.
 *
 * House edge lives in HOUSE_EDGE below, applied transparently via the
 * distribution formula rather than by singling out accounts -- that
 * distinction matters both for player trust and for what a licensed
 * operator has to be able to show a regulator on request.
 */

const HOUSE_EDGE = 0.045 // 4.5% -- set this to whatever your paytable/license declares
const MIN_CRASH = 1.0
const MAX_CRASH = 1000 // ceiling to avoid pathological floats on tiny hash outputs

export interface RoundSeed {
  serverSeed: string
  serverSeedHash: string // safe to publish to clients before the round starts
  roundNumber: number
  clientSeed: string
}

/**
 * Call this when opening a new round.
 * Publish ONLY `serverSeedHash` to clients immediately. Keep `serverSeed`
 * secret server-side until the round has ended, then reveal it for
 * verification.
 */
export function generateRoundSeed(roundNumber: number, clientSeed = 'default'): RoundSeed {
  const serverSeed = randomBytes(32).toString('hex')
  const serverSeedHash = createHash('sha256').update(serverSeed).digest('hex')
  return { serverSeed, serverSeedHash, roundNumber, clientSeed }
}

/**
 * Derives the crash multiplier from a committed seed. Deterministic:
 * same inputs always produce the same output, which is what makes it
 * auditable after the fact.
 */
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
  // The coin-flip for "is this round instant-crash" MUST be decorrelated
  // from `h` (the value that drives the crash magnitude below). h itself
  // is a bad choice for this: small h already maps to crash points near
  // 1.00x in the formula, so gating on "h < threshold" only relabels
  // rounds that were already going to crash around 1.00-1.05x -- it barely
  // touches the 2x/5x/10x tiers and gives away far more than HOUSE_EDGE
  // implies (confirmed by simulation: ~99.5% EV instead of the intended
  // ~95.5% at a 4.5% edge). Pulling the coin-flip from a separate slice
  // of the same HMAC keeps it independent of crash magnitude, so the edge
  // lands flatly across every cashout target instead of just skimming
  // near-1.00x rounds.
  const edgeRoll = parseInt(hmac.slice(13, 26), 16)
  const edgeThreshold = Math.floor(HOUSE_EDGE * E)
  if (edgeRoll < edgeThreshold) {
    return MIN_CRASH
  }

  const crash = Math.floor((100 * E) / (E - h)) / 100
  return Math.min(Math.max(crash, MIN_CRASH), MAX_CRASH)
}

/**
 * Verification function -- expose this (or the equivalent logic) publicly
 * so players/auditors can independently confirm a past round's outcome
 * from the revealed seed. This is the "provably" part of provably fair.
 */
export function verifyRound(seed: RoundSeed, claimedCrashPoint: number): boolean {
  const hashCheck = createHash('sha256').update(seed.serverSeed).digest('hex')
  if (hashCheck !== seed.serverSeedHash) return false
  const recomputed = computeCrashPoint(seed)
  return recomputed === claimedCrashPoint
}