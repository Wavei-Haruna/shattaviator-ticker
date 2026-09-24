import { Firestore } from 'firebase-admin/firestore'
import {
  computeCrashPoint,
  generateRoundSeed,
  RoundSeed,
} from './crash.js'
import { adminDb } from './firebase-admin.js'
import { broadcastState } from './ws-server.js'

type Phase = 'waiting' | 'running' | 'crashed'

export interface Bet {
  uid: string
  slotId: number
  amount: number
  autoCashoutAt: number | null
  cashedOutAt: number | null
  payout: number
}

export interface RoundDoc {
  roundNumber: number
  phase: Phase
  seed: string
  crashPoint: number
  startedAt: number | null
  nextRoundAt: number | null
  createdAt: number
}

export interface PublicState {
  phase: Phase
  roundNumber: number
  serverSeedHash: string
  multiplier: number
  startedAt: number | null
  serverTime: number
  startsInMs: number
  revealedSeed: string | null
  crashPoint: number | null
  history: number[]
}

const WAITING_MS = 8_000
const CRASHED_DISPLAY_MS = 3_000

const MAX_HISTORY = 50
const MAX_SLOTS_PER_USER = 2

const TIME_1_TO_10_MS = 30_000
const TIME_10_TO_50_MS = 15_000
const TIME_50_TO_100_MS = 5_000

const MAX_CURVE_MULTIPLIER = 1000

const RESYNC_EVERY_N_TICKS = 40
const WAITING_BROADCAST_INTERVAL_MS = 1_000

let cachedRound: RoundDoc | null = null
let cachedRoundRef: string | null = null
let ticksSinceResync = 0

let historyCache: number[] = []

let lastWaitingBroadcastAt = 0

function roundRef(roundNumber: number): string {
  return `round-${roundNumber}`
}

/**
 * Multiplier pacing:
 *
 * 1x -> 10x   : 30 seconds
 * 10x -> 50x  : 15 seconds
 * 50x -> 100x : 5 seconds
 * 100x+       : accelerates gradually
 *
 * IMPORTANT:
 * Keep this exact function synchronized with the
 * Vercel/API and client implementation.
 */
export function multiplierFromElapsed(
  elapsedMs: number,
  crashPoint: number | null,
): number {
  const elapsed = Math.max(0, elapsedMs)

  let multiplier: number

  if (elapsed <= TIME_1_TO_10_MS) {
    const progress = elapsed / TIME_1_TO_10_MS

    multiplier = 1 + progress * 9
  } else if (
    elapsed <= TIME_1_TO_10_MS + TIME_10_TO_50_MS
  ) {
    const segmentElapsed =
      elapsed - TIME_1_TO_10_MS

    const progress =
      segmentElapsed / TIME_10_TO_50_MS

    multiplier = 10 + progress * 40
  } else if (
    elapsed <=
    TIME_1_TO_10_MS +
      TIME_10_TO_50_MS +
      TIME_50_TO_100_MS
  ) {
    const segmentElapsed =
      elapsed -
      TIME_1_TO_10_MS -
      TIME_10_TO_50_MS

    const progress =
      segmentElapsed / TIME_50_TO_100_MS

    multiplier = 50 + progress * 50
  } else {
    const segmentElapsed =
      elapsed -
      TIME_1_TO_10_MS -
      TIME_10_TO_50_MS -
      TIME_50_TO_100_MS

    const extraProgress =
      segmentElapsed / 1000

    multiplier =
      100 +
      Math.pow(extraProgress, 1.35) * 25
  }

  const capped = Math.min(
    multiplier,
    MAX_CURVE_MULTIPLIER,
  )

  if (crashPoint !== null) {
    return Math.min(capped, crashPoint)
  }

  return capped
}

function currentMultiplier(
  round: RoundDoc,
  now: number,
): number {
  if (round.phase === 'waiting') {
    return 1
  }

  if (round.phase === 'crashed') {
    return round.crashPoint
  }

  if (!round.startedAt) {
    return 1
  }

  return multiplierFromElapsed(
    now - round.startedAt,
    round.crashPoint,
  )
}

function getServerSeedHash(seed: string): string {
  return seed
}

async function loadHistory(): Promise<number[]> {
  try {
    const snapshot = await adminDb
      .collection('rounds')
      .orderBy('roundNumber', 'desc')
      .limit(MAX_HISTORY)
      .get()

    return snapshot.docs
      .map((doc) => {
        const data = doc.data() as RoundDoc
        return Number(data.crashPoint)
      })
      .filter(
        (value) =>
          Number.isFinite(value) &&
          value >= 1,
      )
  } catch (error) {
    console.error(
      '[ticker] Failed to load history:',
      error,
    )

    return historyCache
  }
}

async function saveRound(
  round: RoundDoc,
): Promise<void> {
  await adminDb
    .collection('rounds')
    .doc(roundRef(round.roundNumber))
    .set(round, { merge: true })
}

async function createWaitingRound(
  roundNumber: number,
): Promise<RoundDoc> {
  const seedData: RoundSeed =
    generateRoundSeed(roundNumber)

  const crashPoint = computeCrashPoint(
    seedData,
  )

  const now = Date.now()

  const round: RoundDoc = {
    roundNumber,
    phase: 'waiting',
    seed: seedData.serverSeed,
    crashPoint,
    startedAt: null,
    nextRoundAt: now + WAITING_MS,
    createdAt: now,
  }

  await saveRound(round)

  return round
}

/**
 * Only creates a round if there is no current round.
 *
 * This does NOT start a running round.
 */
export async function ensureCurrentRound(): Promise<RoundDoc> {
  const metaRef = adminDb
    .collection('meta')
    .doc('currentRound')

  const snapshot = await metaRef.get()

  if (snapshot.exists) {
    const data = snapshot.data()

    if (data?.roundNumber) {
      const roundNumber = Number(
        data.roundNumber,
      )

      const roundSnapshot = await adminDb
        .collection('rounds')
        .doc(roundRef(roundNumber))
        .get()

      if (roundSnapshot.exists) {
        const round =
          roundSnapshot.data() as RoundDoc

        cachedRound = round
        cachedRoundRef =
          roundRef(round.roundNumber)

        return round
      }
    }
  }

  const round = await createWaitingRound(1)

  await metaRef.set({
    roundNumber: round.roundNumber,
    updatedAt: Date.now(),
  })

  cachedRound = round
  cachedRoundRef =
    roundRef(round.roundNumber)

  historyCache = await loadHistory()

  return round
}

/**
 * Read-only current round lookup.
 *
 * This is important:
 * Logging in or connecting to WebSocket does NOT
 * create/start a new round.
 */
export async function getCurrentRound(): Promise<RoundDoc> {
  if (cachedRound) {
    return cachedRound
  }

  return ensureCurrentRound()
}

async function setCurrentRound(
  round: RoundDoc,
): Promise<void> {
  await adminDb
    .collection('meta')
    .doc('currentRound')
    .set({
      roundNumber: round.roundNumber,
      updatedAt: Date.now(),
    })

  cachedRound = round
  cachedRoundRef =
    roundRef(round.roundNumber)
}

async function startRound(
  round: RoundDoc,
  now: number,
): Promise<RoundDoc> {
  if (round.phase !== 'waiting') {
    return round
  }

  const startedRound: RoundDoc = {
    ...round,
    phase: 'running',
    startedAt: now,
    nextRoundAt: null,
  }

  await saveRound(startedRound)
  await setCurrentRound(startedRound)

  console.log(
    `[ticker] Round ${round.roundNumber} started at ${now}`,
  )

  return startedRound
}

async function crashRound(
  round: RoundDoc,
  now: number,
): Promise<RoundDoc> {
  if (round.phase !== 'running') {
    return round
  }

  const crashedRound: RoundDoc = {
    ...round,
    phase: 'crashed',
    nextRoundAt:
      now + CRASHED_DISPLAY_MS,
  }

  await saveRound(crashedRound)
  await setCurrentRound(crashedRound)

  console.log(
    `[ticker] Round ${round.roundNumber} crashed at ${round.crashPoint}x`,
  )

  historyCache = [
    round.crashPoint,
    ...historyCache,
  ].slice(0, MAX_HISTORY)

  return crashedRound
}

async function createNextRound(
  previousRound: RoundDoc,
): Promise<RoundDoc> {
  const nextRoundNumber =
    previousRound.roundNumber + 1

  const nextRound =
    await createWaitingRound(
      nextRoundNumber,
    )

  await setCurrentRound(nextRound)

  console.log(
    `[ticker] Created round ${nextRoundNumber}`,
  )

  return nextRound
}

function getBetCollection(
  roundNumber: number,
) {
  return adminDb
    .collection('rounds')
    .doc(roundRef(roundNumber))
    .collection('bets')
}

async function resolveAutoCashouts(
  round: RoundDoc,
  multiplier: number,
): Promise<void> {
  if (round.phase !== 'running') {
    return
  }

  const snapshot =
    await getBetCollection(
      round.roundNumber,
    )
      .where(
        'cashedOutAt',
        '==',
        null,
      )
      .get()

  if (snapshot.empty) {
    return
  }

  const batch =
    adminDb.batch()

  let changed = false

  for (const doc of snapshot.docs) {
    const bet =
      doc.data() as Bet

    if (
      bet.autoCashoutAt !== null &&
      multiplier >=
        bet.autoCashoutAt
    ) {
      const payout =
        bet.amount *
        bet.autoCashoutAt

      batch.update(doc.ref, {
        cashedOutAt:
          Date.now(),
        payout,
      })

      changed = true
    }
  }

  if (changed) {
    await batch.commit()
  }
}

export function buildStatePayload(
  round: RoundDoc,
  now = Date.now(),
): PublicState {
  const multiplier =
    currentMultiplier(
      round,
      now,
    )

  let startsInMs = 0

  if (
    round.phase === 'waiting' &&
    round.nextRoundAt
  ) {
    startsInMs = Math.max(
      0,
      round.nextRoundAt - now,
    )
  }

  return {
    phase: round.phase,

    roundNumber:
      round.roundNumber,

    serverSeedHash:
      getServerSeedHash(
        round.seed,
      ),

    multiplier,

    startedAt:
      round.startedAt,

    serverTime: now,

    startsInMs,

    revealedSeed:
      round.phase === 'crashed'
        ? round.seed
        : null,

    crashPoint:
      round.phase === 'crashed'
        ? round.crashPoint
        : null,

    history:
      historyCache,
  }
}

async function broadcast(
  round: RoundDoc,
): Promise<void> {
  const state =
    buildStatePayload(
      round,
      Date.now(),
    )

  broadcastState(state as unknown as Record<string, unknown>)
}

async function refreshCachedRound(): Promise<RoundDoc> {
  const round =
    await getCurrentRound()

  cachedRound = round
  cachedRoundRef =
    roundRef(round.roundNumber)

  return round
}

/**
 * Main authoritative server ticker.
 *
 * Railway is the only service allowed to transition
 * rounds through waiting -> running -> crashed.
 */
export async function tick(): Promise<void> {
  const now = Date.now()

  let round: RoundDoc

  if (
    !cachedRound ||
    ticksSinceResync >=
      RESYNC_EVERY_N_TICKS
  ) {
    round =
      await refreshCachedRound()

    ticksSinceResync = 0
  } else {
    round = cachedRound
  }

  ticksSinceResync += 1

  if (round.phase === 'waiting') {
    if (
      round.nextRoundAt !== null &&
      now >= round.nextRoundAt
    ) {
      round =
        await startRound(
          round,
          now,
        )

      await broadcast(round)

      return
    }

    if (
      now -
        lastWaitingBroadcastAt >=
      WAITING_BROADCAST_INTERVAL_MS
    ) {
      lastWaitingBroadcastAt = now

      await broadcast(round)
    }

    return
  }

  if (round.phase === 'running') {
    if (!round.startedAt) {
      return
    }

    const multiplier =
      currentMultiplier(
        round,
        now,
      )

    /**
     * Check crash BEFORE auto cashouts.
     *
     * Once the authoritative crash point has
     * been reached, the round is crashed.
     */
    if (
      multiplier >=
      round.crashPoint
    ) {
      round =
        await crashRound(
          round,
          now,
        )

      await broadcast(round)

      return
    }

    await resolveAutoCashouts(
      round,
      multiplier,
    )

    await broadcast(round)

    return
  }

  if (round.phase === 'crashed') {
    if (
      round.nextRoundAt !== null &&
      now >= round.nextRoundAt
    ) {
      round =
        await createNextRound(
          round,
        )

      await broadcast(round)

      return
    }

    await broadcast(round)
  }
}

/**
 * Server-authoritative cash out.
 *
 * The client never decides the payout multiplier.
 */
export async function cashOut(
  roundNumber: number,
  uid: string,
  slotId: number,
): Promise<{
  success: boolean
  multiplier: number
  payout: number
}> {
  const round =
    await getCurrentRound()

  if (
    round.roundNumber !==
    roundNumber
  ) {
    throw new Error(
      'Round is no longer active',
    )
  }

  if (round.phase !== 'running') {
    throw new Error(
      'Round is not running',
    )
  }

  const now = Date.now()

  const multiplier =
    currentMultiplier(
      round,
      now,
    )

  if (
    multiplier >=
    round.crashPoint
  ) {
    throw new Error(
      'Round already crashed',
    )
  }

  const betRef =
    getBetCollection(
      round.roundNumber,
    ).doc(
      `${uid}-${slotId}`,
    )

  const result =
    await adminDb.runTransaction(
      async (transaction) => {
        const snapshot =
          await transaction.get(
            betRef,
          )

        if (!snapshot.exists) {
          throw new Error(
            'Bet not found',
          )
        }

        const bet =
          snapshot.data() as Bet

        if (
          bet.uid !== uid ||
          bet.slotId !== slotId
        ) {
          throw new Error(
            'Invalid bet',
          )
        }

        if (
          bet.cashedOutAt !==
          null
        ) {
          throw new Error(
            'Already cashed out',
          )
        }

        const payout =
          bet.amount *
          multiplier

        transaction.update(
          betRef,
          {
            cashedOutAt: now,
            payout,
          },
        )

        return {
          success: true,
          multiplier,
          payout,
        }
      },
    )

  return result
}

/**
 * Places a bet only during the waiting phase.
 *
 * Authentication/authorization should be handled
 * by the API layer before calling this function.
 */
export async function placeBet(
  uid: string,
  slotId: number,
  amount: number,
  autoCashoutAt:
    | number
    | null,
): Promise<Bet> {
  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error(
      'Invalid bet amount',
    )
  }

  if (
    !Number.isInteger(slotId) ||
    slotId < 0 ||
    slotId >= MAX_SLOTS_PER_USER
  ) {
    throw new Error(
      'Invalid slot',
    )
  }

  if (
    autoCashoutAt !== null &&
    (!Number.isFinite(
      autoCashoutAt,
    ) ||
      autoCashoutAt <= 1)
  ) {
    throw new Error(
      'Invalid auto cashout',
    )
  }

  const round =
    await getCurrentRound()

  if (round.phase !== 'waiting') {
    throw new Error(
      'Bets are closed',
    )
  }

  const betRef =
    getBetCollection(
      round.roundNumber,
    ).doc(
      `${uid}-${slotId}`,
    )

  const bet: Bet = {
    uid,
    slotId,
    amount,
    autoCashoutAt,
    cashedOutAt: null,
    payout: 0,
  }

  await betRef.set(bet)

  return bet
}

/**
 * Returns the current public game state.
 *
 * This is read-only and cannot start a round.
 */
export async function getPublicState(): Promise<PublicState> {
  const round =
    await getCurrentRound()

  return buildStatePayload(
    round,
    Date.now(),
  )
}