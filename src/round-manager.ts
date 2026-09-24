import { Firestore } from 'firebase-admin/firestore'
import {
  computeCrashPoint,
  generateRoundSeed,
  RoundSeed,
} from './crash.js'
import { adminDb } from '../firebase-admin.js'
import { broadcastState } from './ws-server.js'

type Phase = 'waiting' | 'running' | 'crashed'

interface Bet {
  uid: string
  slotId: number
  amount: number
  autoCashoutAt: number | null
  cashedOutAt: number | null
  payout: number | null
}

interface RoundHistoryEntry {
  roundNumber: number
  crashPoint: number
}

interface RoundDoc {
  roundNumber: number
  phase: Phase
  seed: RoundSeed
  crashPoint: number
  startedAt: number | null
  nextRoundAt: number | null
  createdAt: number
}

const WAITING_MS = 8_000
const CRASHED_DISPLAY_MS = 3_000

/*
 * KEEP THESE IDENTICAL TO THE CLIENT AND VERCEL COPY.
 */
const TIME_1_TO_10_MS = 30_000
const TIME_10_TO_50_MS = 15_000
const TIME_50_TO_100_MS = 5_000
const MAX_CURVE_MULTIPLIER = 1000

function multiplierFromElapsed(
  elapsedMs: number,
  crashPoint: number | null,
): number {
  const elapsed = Math.max(0, elapsedMs)

  let multiplier: number

  if (elapsed <= TIME_1_TO_10_MS) {
    const progress = elapsed / TIME_1_TO_10_MS
    multiplier = 1 + progress * 9
  } else if (
    elapsed <=
    TIME_1_TO_10_MS + TIME_10_TO_50_MS
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

    const extraProgress = segmentElapsed / 1_000

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

  if (round.startedAt === null) {
    return 1
  }

  const elapsed = Math.max(
    0,
    now - round.startedAt,
  )

  return multiplierFromElapsed(
    elapsed,
    round.crashPoint,
  )
}

const MAX_HISTORY = 50
const WAITING_BROADCAST_INTERVAL_MS = 1_000

let lastWaitingBroadcastAt = 0

const db: Firestore = adminDb
const roundsCol = db.collection('rounds')
const metaDoc = db.collection('meta').doc('currentRound')
const counterDoc = db.collection('meta').doc('roundCounter')

let cachedRound: RoundDoc | null = null
let cachedRoundRef:
  | FirebaseFirestore.DocumentReference
  | null = null

let ticksSinceResync = 0
const RESYNC_EVERY_N_TICKS = 40

let historyCache: RoundHistoryEntry[] = []

function betId(uid: string, slotId: number) {
  return `${uid}_${slotId}`
}

async function ensureCurrentRound(): Promise<string> {
  return db.runTransaction(async (tx) => {
    const metaSnap = await tx.get(metaDoc)

    if (metaSnap.exists) {
      return metaSnap.data()!.roundId as string
    }

    const counterSnap = await tx.get(counterDoc)

    const nextNumber =
      (counterSnap.exists
        ? counterSnap.data()!.value
        : Math.floor(Date.now() / 1000)) + 1

    const seed = generateRoundSeed(nextNumber)
    const crashPoint = computeCrashPoint(seed)
    const now = Date.now()

    const roundRef = roundsCol.doc(
      String(nextNumber),
    )

    const doc: RoundDoc = {
      roundNumber: nextNumber,
      phase: 'waiting',
      seed,
      crashPoint,
      startedAt: null,
      nextRoundAt: now + WAITING_MS,
      createdAt: now,
    }

    tx.set(roundRef, doc)
    tx.set(counterDoc, {
      value: nextNumber,
    })
    tx.set(metaDoc, {
      roundId: roundRef.id,
    })

    return roundRef.id
  })
}

async function loadRoundFromFirestore() {
  const roundId =
    await ensureCurrentRound()

  const roundRef = roundsCol.doc(roundId)
  const snap = await roundRef.get()

  if (!snap.exists) {
    throw new Error(
      'Current round does not exist.',
    )
  }

  cachedRoundRef = roundRef
  cachedRound = snap.data() as RoundDoc

  return cachedRound
}

async function refreshHistory() {
  const snap = await roundsCol
    .where('phase', '==', 'crashed')
    .orderBy('roundNumber', 'desc')
    .limit(MAX_HISTORY)
    .get()

  historyCache = snap.docs.map((d) => {
    const data = d.data() as RoundDoc

    return {
      roundNumber: data.roundNumber,
      crashPoint: data.crashPoint,
    }
  })
}

function multiplierColor(
  value: number,
): 'blue' | 'purple' | 'pink' {
  if (value < 2) return 'blue'
  if (value < 10) return 'purple'
  return 'pink'
}

function buildStatePayload(
  round: RoundDoc,
) {
  const now = Date.now()

  return {
    type: 'state',

    phase: round.phase,

    roundNumber: round.roundNumber,

    serverSeedHash:
      round.seed.serverSeedHash,

    multiplier: Number(
      currentMultiplier(
        round,
        now,
      ).toFixed(2),
    ),

    /*
     * This is the original server timestamp.
     * It NEVER changes when a client connects.
     */
    startedAt:
      round.phase === 'running'
        ? round.startedAt
        : null,

    /*
     * Client uses this to calculate:
     *
     * serverNow = Date.now() + offset
     */
    serverTime: now,

    startsInMs:
      round.phase === 'waiting'
        ? Math.max(
            0,
            (round.nextRoundAt ?? now) - now,
          )
        : null,

    revealedSeed:
      round.phase === 'crashed'
        ? round.seed.serverSeed
        : null,

    crashPoint:
      round.phase === 'crashed'
        ? round.crashPoint
        : null,

    history: historyCache.map((h) => ({
      roundNumber: h.roundNumber,
      value: h.crashPoint,
      color: multiplierColor(
        h.crashPoint,
      ),
    })),
  }
}

async function broadcast(
  round: RoundDoc,
) {
  broadcastState(
    buildStatePayload(round),
  )
}

async function resolveAutoCashouts(
  roundRef: FirebaseFirestore.DocumentReference,
  round: RoundDoc,
  now: number,
) {
  if (round.phase !== 'running') {
    return
  }

  const live = currentMultiplier(
    round,
    now,
  )

  const dueSnap = await roundRef
    .collection('bets')
    .where('cashedOutAt', '==', null)
    .where(
      'autoCashoutAt',
      '<=',
      live,
    )
    .get()

  if (dueSnap.empty) {
    return
  }

  const batch = db.batch()

  dueSnap.forEach((doc) => {
    const bet = doc.data() as Bet

    if (bet.autoCashoutAt === null) {
      return
    }

    const autoCashoutAt =
      bet.autoCashoutAt

    const payout =
      Math.floor(
        bet.amount *
          autoCashoutAt *
          100,
      ) / 100

    batch.update(doc.ref, {
      cashedOutAt:
        autoCashoutAt,
      payout,
    })
  })

  await batch.commit()
}

export async function tick(): Promise<RoundDoc> {
  /*
   * Initial load.
   */
  if (
    cachedRound === null ||
    cachedRoundRef === null
  ) {
    await loadRoundFromFirestore()
  }

  /*
   * Periodic authoritative resync.
   */
  ticksSinceResync++

  if (
    ticksSinceResync >=
    RESYNC_EVERY_N_TICKS
  ) {
    ticksSinceResync = 0
    await loadRoundFromFirestore()
  }

  if (
    cachedRound === null ||
    cachedRoundRef === null
  ) {
    throw new Error(
      'Round cache unavailable.',
    )
  }

  let round = cachedRound
  let roundRef = cachedRoundRef

  const now = Date.now()

  /*
   * WAITING -> RUNNING
   */
  if (
    round.phase === 'waiting' &&
    round.nextRoundAt !== null &&
    now >= round.nextRoundAt
  ) {
    await db.runTransaction(async (tx) => {
      const fresh =
        await tx.get(roundRef)

      if (!fresh.exists) {
        return
      }

      const data =
        fresh.data() as RoundDoc

      if (
        data.phase !== 'waiting'
      ) {
        return
      }

      /*
       * This timestamp is the actual
       * beginning of the round.
       *
       * It is NOT based on any client.
       */
      const startedAt =
        Date.now()

      tx.update(roundRef, {
        phase: 'running',
        startedAt,
        nextRoundAt: null,
      })
    })

    await loadRoundFromFirestore()

    round = cachedRound!
    roundRef = cachedRoundRef!

    await broadcast(round)
  }

  /*
   * RUNNING
   */
  if (round.phase === 'running') {
    const liveNow = Date.now()

    const multiplier =
      currentMultiplier(
        round,
        liveNow,
      )

    /*
     * Crash first.
     */
    if (
      multiplier >=
      round.crashPoint
    ) {
      const crashedAt =
        Date.now()

      await db.runTransaction(
        async (tx) => {
          const fresh =
            await tx.get(roundRef)

          if (!fresh.exists) {
            return
          }

          const data =
            fresh.data() as RoundDoc

          if (
            data.phase !==
            'running'
          ) {
            return
          }

          tx.update(roundRef, {
            phase: 'crashed',
            nextRoundAt:
              crashedAt +
              CRASHED_DISPLAY_MS,
          })
        },
      )

      await loadRoundFromFirestore()

      round = cachedRound!
      roundRef = cachedRoundRef!

      await refreshHistory()

      await broadcast(round)

      await resolveAutoCashouts(
        roundRef,
        round,
        crashedAt,
      )
    } else {
      await resolveAutoCashouts(
        roundRef,
        round,
        liveNow,
      )
    }
  }

  /*
   * CRASHED -> WAITING
   */
  if (
    round.phase === 'crashed' &&
    round.nextRoundAt !== null &&
    Date.now() >=
      round.nextRoundAt
  ) {
    const oldRoundId =
      roundRef.id

    const newRoundId =
      await db.runTransaction(
        async (tx) => {
          const metaSnap =
            await tx.get(
              metaDoc,
            )

          if (
            !metaSnap.exists
          ) {
            throw new Error(
              'Current round metadata missing.',
            )
          }

          if (
            metaSnap.data()!
              .roundId !==
            oldRoundId
          ) {
            return metaSnap.data()!
              .roundId as string
          }

          const counterSnap =
            await tx.get(
              counterDoc,
            )

          const nextNumber =
            (counterSnap.data()!
              .value as number) +
            1

          const seed =
            generateRoundSeed(
              nextNumber,
            )

          const crashPoint =
            computeCrashPoint(
              seed,
            )

          const start =
            Date.now()

          const newRef =
            roundsCol.doc(
              String(nextNumber),
            )

          const doc: RoundDoc = {
            roundNumber:
              nextNumber,
            phase: 'waiting',
            seed,
            crashPoint,
            startedAt: null,
            nextRoundAt:
              start +
              WAITING_MS,
            createdAt: start,
          }

          tx.set(
            newRef,
            doc,
          )

          tx.set(
            counterDoc,
            {
              value:
                nextNumber,
            },
          )

          tx.set(
            metaDoc,
            {
              roundId:
                newRef.id,
            },
          )

          return newRef.id
        },
      )

    roundRef =
      roundsCol.doc(
        newRoundId,
      )

    const snap =
      await roundRef.get()

    if (!snap.exists) {
      throw new Error(
        'New round was not created.',
      )
    }

    round =
      snap.data() as RoundDoc

    cachedRound =
      round

    cachedRoundRef =
      roundRef

    await broadcast(round)
  }

  /*
   * WAITING countdown.
   *
   * Broadcast approximately once per second.
   */
  if (
    round.phase === 'waiting'
  ) {
    const nowWaiting =
      Date.now()

    if (
      nowWaiting -
        lastWaitingBroadcastAt >=
      WAITING_BROADCAST_INTERVAL_MS
    ) {
      lastWaitingBroadcastAt =
        nowWaiting

      await broadcast(round)
    }
  }

  return round
}

export async function getRoundHistory(): Promise<
  RoundHistoryEntry[]
> {
  if (
    historyCache.length === 0
  ) {
    await refreshHistory()
  }

  return historyCache
}