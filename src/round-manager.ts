// This is a copy of lib/game/round-manager.ts from the main Vercel app.
// It needs to live here too because this is a separate deployed service
// (Railway) with its own dependency tree -- it can't import across repos.
//
// If you keep both projects in one monorepo, you can skip the
// duplication by making this a shared workspace package instead. For
// now, treat this file as authoritative for tick()/resolveAutoCashouts()
// and the Vercel copy as authoritative for the read-only functions
// (getPublicState/placeBet/cashOut) -- keep them in sync if you touch the
// shared bits (RoundDoc shape, currentMultiplier, growth constants).
//
// NEW: this copy also owns broadcasting. It builds the same JSON shape
// Vercel's getPublicState() returns and pushes it over the WS server
// (lib/game/ws-server.ts) on every phase transition, plus a throttled
// once/sec push during 'waiting' so the client's countdown doesn't freeze
// (the countdown, unlike the running multiplier, isn't recomputed locally
// on the client -- see buildStatePayload's history/countdown notes below).

import { Firestore } from 'firebase-admin/firestore'
import { computeCrashPoint, generateRoundSeed, RoundSeed } from './crash.js'
import { adminDb } from './firebase-admin.js'
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

const WAITING_MS = 5_000
const CRASHED_DISPLAY_MS = 3_000

// Keep these in sync with the Vercel copy -- they determine the growth
// curve, and a mismatch would mean the ticker crashes rounds at a
// different rate than the client's own multiplier display expects.
const GROWTH_BASE_PER_MS = 0.00016
const GROWTH_ACCEL_PER_MS2 = 0.0000000075

const MAX_HISTORY = 50

// How often to re-broadcast during 'waiting' just to keep the countdown
// moving. Transitions always broadcast regardless of this.
const WAITING_BROADCAST_INTERVAL_MS = 1_000
let lastWaitingBroadcastAt = 0

const db: Firestore = adminDb
const roundsCol = db.collection('rounds')
const metaDoc = db.collection('meta').doc('currentRound')
const counterDoc = db.collection('meta').doc('roundCounter')

function currentMultiplier(round: RoundDoc, now: number): number {
  if (round.phase === 'waiting') return 1
  if (round.phase === 'crashed') return round.crashPoint
  const elapsed = now - (round.startedAt ?? now)
  const exponent = GROWTH_BASE_PER_MS * elapsed + GROWTH_ACCEL_PER_MS2 * elapsed * elapsed
  return Math.min(Math.exp(exponent), round.crashPoint)
}

// Duplicated from the Vercel copy -- only used here to color history
// chips in the broadcast payload. Keep in sync if you change the tiers.
function multiplierColor(value: number): 'blue' | 'purple' | 'pink' {
  if (value >= 10) return 'pink'
  if (value >= 2) return 'purple'
  return 'blue'
}

async function ensureCurrentRound(): Promise<string> {
  return db.runTransaction(async (tx) => {
    const metaSnap = await tx.get(metaDoc)
    if (metaSnap.exists) {
      return metaSnap.data()!.roundId as string
    }
    const counterSnap = await tx.get(counterDoc)
    const nextNumber = (counterSnap.exists ? counterSnap.data()!.value : Math.floor(Date.now() / 1000)) + 1
    const seed = generateRoundSeed(nextNumber)
    const crashPoint = computeCrashPoint(seed)
    const now = Date.now()
    const roundRef = roundsCol.doc(String(nextNumber))
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
    tx.set(counterDoc, { value: nextNumber })
    tx.set(metaDoc, { roundId: roundRef.id })
    return roundRef.id
  })
}

// Builds the exact same shape Vercel's getPublicState() returns, so the
// client's `msg.<field>` reads (in useGameSocket) line up regardless of
// whether the client polled Vercel or got pushed this over the socket.
async function buildStatePayload(round: RoundDoc) {
  const now = Date.now()
  const historySnap = await roundsCol
    .where('phase', '==', 'crashed')
    .orderBy('roundNumber', 'desc')
    .limit(MAX_HISTORY)
    .get()
  const history: RoundHistoryEntry[] = historySnap.docs.map((d) => {
    const data = d.data() as RoundDoc
    return { roundNumber: data.roundNumber, crashPoint: data.crashPoint }
  })

  return {
    phase: round.phase,
    roundNumber: round.roundNumber,
    serverSeedHash: round.seed.serverSeedHash,
    multiplier: Number(currentMultiplier(round, now).toFixed(2)),
    startedAt: round.phase === 'running' ? round.startedAt : null,
    serverTime: now,
    startsInMs: round.phase === 'waiting' ? Math.max(0, (round.nextRoundAt ?? now) - now) : null,
    revealedSeed: round.phase === 'crashed' ? round.seed.serverSeed : null,
    crashPoint: round.phase === 'crashed' ? round.crashPoint : null,
    history: history.map((h) => ({
      roundNumber: h.roundNumber,
      value: h.crashPoint,
      color: multiplierColor(h.crashPoint),
    })),
  }
}

async function broadcast(round: RoundDoc) {
  broadcastState(await buildStatePayload(round))
}

// The only writer to round-phase state in the whole system. Called every
// TICK_MS from index.ts's setInterval loop.
export async function tick(): Promise<RoundDoc> {
  const roundId = await ensureCurrentRound()
  let roundRef = roundsCol.doc(roundId)
  let snap = await roundRef.get()
  let round = snap.data() as RoundDoc
  const now = Date.now()

  if (round.phase === 'waiting' && round.nextRoundAt !== null && now >= round.nextRoundAt) {
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(roundRef)
      const data = fresh.data() as RoundDoc
      if (data.phase !== 'waiting') return
      tx.update(roundRef, { phase: 'running', startedAt: now, nextRoundAt: null })
    })
    snap = await roundRef.get()
    round = snap.data() as RoundDoc
    await broadcast(round) // transition: waiting -> running
  }

  if (round.phase === 'running') {
    await resolveAutoCashouts(roundRef, round, Date.now())
    if (currentMultiplier(round, Date.now()) >= round.crashPoint) {
      const crashedAt = Date.now()
      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(roundRef)
        const data = fresh.data() as RoundDoc
        if (data.phase !== 'running') return
        tx.update(roundRef, { phase: 'crashed', nextRoundAt: crashedAt + CRASHED_DISPLAY_MS })
      })
      snap = await roundRef.get()
      round = snap.data() as RoundDoc
      await broadcast(round) // transition: running -> crashed
    }
  }

  if (round.phase === 'crashed' && round.nextRoundAt !== null && Date.now() >= round.nextRoundAt) {
    const newRoundId = await db.runTransaction(async (tx) => {
      const metaSnap = await tx.get(metaDoc)
      if (metaSnap.data()!.roundId !== roundId) {
        return metaSnap.data()!.roundId as string
      }
      const counterSnap = await tx.get(counterDoc)
      const nextNumber = (counterSnap.data()!.value as number) + 1
      const seed = generateRoundSeed(nextNumber)
      const crashPoint = computeCrashPoint(seed)
      const start = Date.now()
      const newRef = roundsCol.doc(String(nextNumber))
      const doc: RoundDoc = {
        roundNumber: nextNumber,
        phase: 'waiting',
        seed,
        crashPoint,
        startedAt: null,
        nextRoundAt: start + WAITING_MS,
        createdAt: start,
      }
      tx.set(newRef, doc)
      tx.set(counterDoc, { value: nextNumber })
      tx.set(metaDoc, { roundId: newRef.id })
      return newRef.id
    })
    roundRef = roundsCol.doc(newRoundId)
    snap = await roundRef.get()
    round = snap.data() as RoundDoc
    lastWaitingBroadcastAt = Date.now()
    await broadcast(round) // transition: crashed -> waiting (new round)
  } else if (round.phase === 'waiting' && Date.now() - lastWaitingBroadcastAt >= WAITING_BROADCAST_INTERVAL_MS) {
    // Not a phase transition -- just keeps the "next round in Xs"
    // countdown moving on the client, since (unlike the running
    // multiplier) it isn't recomputed locally between pushes.
    lastWaitingBroadcastAt = Date.now()
    await broadcast(round)
  }

  return round
}

async function resolveAutoCashouts(roundRef: FirebaseFirestore.DocumentReference, round: RoundDoc, now: number) {
  const live = currentMultiplier(round, now)
  const dueSnap = await roundRef
    .collection('bets')
    .where('cashedOutAt', '==', null)
    .where('autoCashoutAt', '<=', live)
    .get()
  if (dueSnap.empty) return
  const batch = db.batch()
  dueSnap.forEach((doc) => {
    const bet = doc.data() as Bet
    const autoCashoutAt = bet.autoCashoutAt as number
    const payout = Math.floor(bet.amount * autoCashoutAt * 100) / 100
    batch.update(doc.ref, { cashedOutAt: autoCashoutAt, payout })
  })
  await batch.commit()
}