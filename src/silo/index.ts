import type { SiloRequest, SiloResponse } from './api'
import { api } from './store'

// The silo: the database's own process (an Electron utility process started by main/silo.ts).
// It alone opens oats.db, so a slow query or a long write never stalls the main process,
// which runs the windows and everything else. Requests are handled one at a time, in the
// order they arrive; a failed one is answered with its error and changes nothing else.

process.parentPort.on('message', ({ data }: { data: SiloRequest }) => {
  let reply: SiloResponse
  try {
    const method = api[data.method] as (...args: unknown[]) => unknown
    reply = { id: data.id, result: method(...data.args) }
  } catch (err) {
    reply = { id: data.id, error: err instanceof Error ? err.message : String(err) }
  }
  process.parentPort.postMessage(reply)
})
