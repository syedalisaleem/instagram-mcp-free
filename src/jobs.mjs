/**
 * Background jobs — the shape every long-running tool in this contract has.
 *
 * `downloads_start`, `insights_collect`, `unfollowers_scan`, `peers_scan` and `antibot_scan`
 * all make the same promise: return immediately with a job id, do the work in the background,
 * and let the caller poll a report tool for progress. INSSIST keeps those in their own
 * service; here they run in this process, which is the honest trade — a job dies with the
 * driver, so a report polled after a restart says "not running" instead of pretending the
 * work is still in flight.
 *
 * Jobs are deliberately kept in memory only. They hold account data, and a cache file would
 * be one more place a follower list sits on disk after the user stops caring about it.
 */

const jobs = new Map()

const KINDS = ['download', 'insights', 'unfollowers', 'peers', 'antibot']

/**
 * Starts a job and returns its record immediately.
 *
 * `run` receives the record and mutates it as it goes — `job.total`, `job.done`, `job.step`,
 * `job.result`. Throwing moves it to `failed` with the message attached, which is what the
 * report tools surface rather than an unhandled rejection that loses the job entirely.
 */
export const startJob = (kind, label, run) => {
  if (!KINDS.includes(kind)) throw new Error(`Unknown job kind "${kind}"`)

  const job = {
    id: `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    label,
    state: 'running',
    step: 'starting',
    total: null,
    done: 0,
    startedOn: new Date().toISOString(),
    finishedOn: null,
    error: null,
    result: null,
  }
  jobs.set(job.id, job)

  // Not awaited: the whole point is that `startJob` returns before the work does.
  ;(async () => {
    try {
      await run(job)
      if (job.state === 'running') {
        job.state = 'done'
        job.finishedOn = new Date().toISOString()
      }
    } catch (error) {
      job.state = 'failed'
      job.error = String(error?.message ?? error)
      job.finishedOn = new Date().toISOString()
    }
  })()

  return job
}

/** One job by id, or null — a missing id is a normal answer, not an error. */
export const getJob = id => (id ? (jobs.get(id) ?? null) : null)

/** Every job, newest first, optionally narrowed to one kind. */
export const listJobs = kind => {
  const all = [...jobs.values()]
    .filter(job => !kind || job.kind === kind)
    .sort((a, b) => (a.startedOn < b.startedOn ? 1 : -1))
  return all
}

/**
 * Cancels a running job.
 *
 * The runner cannot abort arbitrary awaits, so cancelling flips a flag the job's own loop
 * checks. `job.cancelled` is the contract between this file and the job bodies.
 */
export const cancelJob = job => {
  if (!job) return false
  if (job.state !== 'running') return false
  job.cancelled = true
  job.state = 'cancelled'
  job.finishedOn = new Date().toISOString()
  return true
}

/** The fields every report tool returns, so status output looks the same across families. */
export const jobStatus = job => ({
  jobId: job.id,
  label: job.label,
  scanning: job.state === 'running',
  state: job.state,
  step: job.step,
  done: job.done,
  total: job.total,
  startedOn: job.startedOn,
  finishedOn: job.finishedOn,
  error: job.error,
})
