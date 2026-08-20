// This is a copy of lib/game/round-manager.ts from the main Vercel app.
// It needs to live here too because this is a separate deployed service
// (Railway) with its own dependency tree — it can't import across repos.
//
// If you keep both projects in one monorepo, you can skip the
// duplication by making this a shared workspace package instead. For
// now, treat this file as authoritative for tick()/resolveAutoCashouts()
// and the Vercel copy as authoritative for the read-only functions
// (getPublicState/placeBet/cashOut) — keep them in sync if you touch the
// shared bits (RoundDoc shape, currentMultiplier, growth constants).

import { Firestore } from 'firebase-admin/firestore'
import { computeCrashPoint, generateRoundSeed, RoundSeed } from './crash.js'
import { adminDb } from './firebase-admin.js'

type Phase = 'waiting' | 'running' | 'crashed'

interface Bet {
  uid: string
  slotId: number
  amount: number
  autoCashoutAt: number | null
  cashedOutAt: number | null
  payout: number | null
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

// Keep these in sync with the Vercel copy — they determine the growth
// curve, and a mismatch would mean the ticker crashes rounds at a
// different rate than the client's own multiplier display expects.
const GROWTH_BASE_PER_MS = 0.00016
const GROWTH_ACCEL_PER_MS2 = 0.0000000075

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
