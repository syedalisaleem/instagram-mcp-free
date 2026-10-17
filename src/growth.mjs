/**
 * `growth_*` — the five tools this driver deliberately does not implement.
 *
 * INSSIST's growth engine is not an Instagram feature with an endpoint behind it. It is their
 * own hosted automation: you hand it a list of target accounts, and it likes their posts from
 * your account on a schedule to farm reciprocal engagement. Nothing about that exists on
 * instagram.com to call — it is work performed by their servers acting as you.
 *
 * Reproducing it would mean this driver entering a loop that mass-likes strangers' posts, which
 * is precisely the behaviour Instagram's automation detection is built to catch, on a session
 * that carries a real person's account. A driver that reported success while doing that would
 * be worse than one that says no: it would spend the user's account trust and claim credit for
 * it. So each tool answers with the same structured refusal, naming what it is, why it is not
 * here, and the safe equivalent that is.
 *
 * These are the only five of the sixty where that applies. Every other gap in this driver is a
 * missing endpoint, and says so differently.
 */

const REFUSAL = tool => ({
  notImplemented: true,
  tool,
  available: false,
  reason: 'not-replicable',
  note:
    "INSSIST's growth engine is their own hosted auto-engagement service, not an Instagram endpoint. " +
    'Reimplementing it would have this driver automatically liking posts from strangers in a loop, ' +
    "which is exactly what Instagram's automation detection targets — on your signed-in session. " +
    'Deliberately not stubbed as working.',
  safeAlternative:
    'Use `ig_action` with type "like" to engage with a specific post deliberately, one at a time. ' +
    'Account growth tools that auto-like on a schedule are the most common reason accounts get limited.',
  appliesTo: ['growth_configure', 'growth_export', 'growth_pause', 'growth_start', 'growth_status'],
})

export const growthConfigure = () => ({
  ...REFUSAL('growth_configure'),
  note: `${REFUSAL('growth_configure').note} Configuration is also not available: there is no queue to configure.`,
})

export const growthExport = () => ({
  ...REFUSAL('growth_export'),
  note: `${REFUSAL('growth_export').note} There is no activity log to export, because nothing runs.`,
})

export const growthPause = () => ({
  ...REFUSAL('growth_pause'),
  paused: false,
  note: `${REFUSAL('growth_pause').note} Nothing is running, so there is nothing to pause.`,
})

export const growthStart = () => ({
  ...REFUSAL('growth_start'),
  started: false,
  running: false,
  note: `${REFUSAL('growth_start').note} No job was started.`,
})

export const growthStatus = () => ({
  ...REFUSAL('growth_status'),
  on: false,
  running: false,
  active: false,
  config: null,
  recent: [],
  note: `${REFUSAL('growth_status').note} Reports "off" because nothing here runs it.`,
})
