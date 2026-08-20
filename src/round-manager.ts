// Round state now lives in Firestore instead of in-process memory.
//
// ARCHITECTURE: this file is deployed in TWO places now.
//   1. Here, on Vercel — the API routes (getPublicState, placeBet,
//      cashOut) ONLY READ round state. They never call tick().
//   2. A separate always-on Railway service is the ONLY thing that calls
//      tick(). It runs setInterval(tick, 250ms) in a long-lived process.
//
// SECURITY: `serverSeed` and `crashPoint` are stored in these documents
// and must NEVER be readable by the client-side Firestore SDK before the
// round has crashed. `startedAt`, added to getPublicState()'s response
// below, is safe to expose pre-crash — it's just a timestamp, not the
// seed or the crash point itself, and the growth formula it feeds into
// was already fully observable by anyone watching the animated
// multiplier client-side.

import { Firestore } from 'firebase-admin/firestore'
import { computeCrashPoint, generateRoundSeed, RoundSeed } from "./crash"
import { adminDb } from '../firebase-admin'

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

// multiplier(t) = e^(GROWTH_BASE_PER_MS * t + GROWTH_ACCEL_PER_MS2 * t^2)
// Slow-start-then-accelerate curve — 2x ~3.7s, 5x ~7.5s, 10x ~9.9s, 50x ~14.5s.
// IMPORTANT: these two constants are duplicated in the client
// (app/game/page.tsx) so it can compute the same curve locally for
// smooth per-frame animation. Keep both copies in sync if you tune this.
const GROWTH_BASE_PER_MS = 0.00016
const GROWTH_ACCEL_PER_MS2 = 0.0000000075

const MAX_HISTORY = 50
const MAX_SLOTS_PER_USER = 2

const db: Firestore = adminDb
const roundsCol = db.collection('rounds')
const metaDoc = db.collection('meta').doc('currentRound')
const counterDoc = db.collection('meta').doc('roundCounter')

function betId(uid: string, slotId: number) {
  return `${uid}_${slotId}`
}

function currentMultiplier(round: RoundDoc, now: number): number {
  if (round.phase === 'waiting') return 1
  if (round.phase === 'crashed') return round.crashPoint
  const elapsed = now - (round.startedAt ?? now)
  const exponent = GROWTH_BASE_PER_MS * elapsed + GROWTH_ACCEL_PER_MS2 * elapsed * elapsed
  return Math.min(Math.exp(exponent), round.crashPoint)
}

export function multiplierColor(value: number): 'blue' | 'purple' | 'pink' {
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

// READ-ONLY. Used by every Vercel API route. Never advances phase.
async function getCurrentRound(): Promise<RoundDoc> {
  const roundId = await ensureCurrentRound()
  const snap = await roundsCol.doc(roundId).get()
  return snap.data() as RoundDoc
}

// WRITE PATH. Only ever called from the Railway ticker service now.
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

export async function getPublicState() {
  const round = await getCurrentRound()
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
    // NEW: lets the client animate the curve itself every frame instead
    // of only updating visually once per poll (which was causing the
    // "counts then pauses" stutter — the spring was racing to catch up
    // to a new snapshot every 250ms instead of animating continuously).
    startedAt: round.phase === 'running' ? round.startedAt : null,
    // NEW: server's Date.now() at the moment this response was built, so
    // the client can compute a clock offset and estimate "server now"
    // for its local animation without trusting its own clock outright.
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

export async function placeBet(uid: string, amount: number, opts?: { slotId?: number; autoCashoutAt?: number | null }) {
  const round = await getCurrentRound()
  const slotId = opts?.slotId ?? 0
  if (slotId < 0 || slotId >= MAX_SLOTS_PER_USER) return { ok: false as const, error: 'Invalid bet slot.' }
  if (round.phase !== 'waiting') return { ok: false as const, error: 'Betting is closed for this round.' }
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false as const, error: 'Invalid bet amount.' }
  const autoCashoutAt = opts?.autoCashoutAt ?? null
  if (autoCashoutAt !== null && (!Number.isFinite(autoCashoutAt) || autoCashoutAt <= 1)) {
    return { ok: false as const, error: 'Auto cash-out must be greater than 1.00x.' }
  }

  const roundRef = roundsCol.doc(String(round.roundNumber))
  const betRef = roundRef.collection('bets').doc(betId(uid, slotId))
  const placed = await db.runTransaction(async (tx) => {
    const existing = await tx.get(betRef)
    if (existing.exists) return false
    const bet: Bet = { uid, slotId, amount, autoCashoutAt, cashedOutAt: null, payout: null }
    tx.set(betRef, bet)
    return true
  })
  if (!placed) return { ok: false as const, error: 'You already have a bet in this slot.' }
  return { ok: true as const, roundNumber: round.roundNumber, slotId }
}

export async function cashOut(uid: string, slotId = 0) {
  const round = await getCurrentRound()
  if (round.phase !== 'running') return { ok: false as const, error: 'No live round to cash out of.' }
  const roundRef = roundsCol.doc(String(round.roundNumber))
  const betRef = roundRef.collection('bets').doc(betId(uid, slotId))

  const result = await db.runTransaction(async (tx) => {
    const betSnap = await tx.get(betRef)
    if (!betSnap.exists) return { ok: false as const, error: 'No active bet found in that slot.' }
    const bet = betSnap.data() as Bet
    if (bet.cashedOutAt !== null) return { ok: false as const, error: 'Already cashed out.' }
    const multiplier = currentMultiplier(round, Date.now())
    const payout = Math.floor(bet.amount * multiplier * 100) / 100
    tx.update(betRef, { cashedOutAt: multiplier, payout })
    return { ok: true as const, multiplier, payout }
  })
  return result
}

export async function getRoundHistory(): Promise<RoundHistoryEntry[]> {
  const snap = await roundsCol
    .where('phase', '==', 'crashed')
    .orderBy('roundNumber', 'desc')
    .limit(MAX_HISTORY)
    .get()
  return snap.docs.map((d) => {
    const data = d.data() as RoundDoc
    return { roundNumber: data.roundNumber, crashPoint: data.crashPoint }
  })
}
