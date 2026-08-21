import type { Server } from 'node:http'
// This project does not include ws' optional TypeScript declarations.
// Keep the runtime import working without requiring a dependency change.
// @ts-expect-error -- ws has no declaration file in this project.
import { WebSocket, WebSocketServer } from 'ws'
import { getAuth } from 'firebase-admin/auth'

// Round state is public data — it's the same thing Vercel's unauthenticated
// /api/game/state route already returns. So we do NOT gate the connection
// on auth: every client gets state pushes whether or not it ever sends a
// token. If the client's first message does include a Firebase ID token
// (the current useGameSocket hook always sends one, since it only opens
// the socket once a user is logged in), we verify it and stash the uid on
// the socket for later, in case per-user pushes are ever needed -- but a
// failed/missing/slow token never blocks or drops the connection.
interface WsClient extends WebSocket {
  uid?: string
  readyState: number
  send(data: string): void
  once(event: 'message', listener: (raw: { toString(): string }) => void): this
  on(event: 'close', listener: () => void): this
  on(event: 'error', listener: (err: unknown) => void): this
}

interface AuthMessage {
  token?: string
}

const clients = new Set<WsClient>()

let lastPayload: Record<string, unknown> | null = null

export function createGameWsServer(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws: WsClient) => {
    clients.add(ws)
    console.log(`[ws] client connected (${clients.size} total)`)

    if (lastPayload) {
      ws.send(JSON.stringify({ type: 'state', ...lastPayload }))
    }

    ws.once('message', async (raw) => {
      try {
        const msg: AuthMessage = JSON.parse(raw.toString()) as AuthMessage
        if (typeof msg?.token === 'string') {
          const decoded = await getAuth().verifyIdToken(msg.token)
          ws.uid = decoded.uid
        }
      } catch (err) {
        // Not fatal -- the client just stays an unauthenticated viewer.
        console.warn('[ws] token verify failed, continuing as guest:', (err as Error).message)
      }
    })

    ws.on('close', () => {
      clients.delete(ws)
      console.log(`[ws] client disconnected (${clients.size} total)`)
    })

    ws.on('error', (err) => {
      console.error('[ws] socket error:', err)
    })
  })

  wss.on('error', (err: unknown) => {
    console.error('[ws] server error:', err)
  })

  return wss
}

// Called from round-manager.ts's tick() on every phase transition (and,
// throttled, once/sec during the 'waiting' countdown -- see round-manager
// for why). Payload shape mirrors Vercel's getPublicState() exactly, so
// the client hook's `msg.<field>` reads line up.
export function broadcastState(payload: Record<string, unknown>) {
  lastPayload = payload
  const msg = JSON.stringify({ type: 'state', ...payload })
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg)
  }
}