/**
 * Media downloads: one post, or a whole account, saved to a local folder with a manifest.
 *
 * The listing half runs through the browser session exactly like every other read, but the
 * bytes do not. Instagram's media lives on signed CDN hosts (`cdn.instagram.com`,
 * `fbcdn.net`), and those URLs are public for their lifetime — no cookie is needed or sent,
 * and routing a 40 MB video through the extension's same-origin page fetch would be both
 * slower and wrong: the content script only reaches same-origin URLs by design, so that path
 * cannot serve cross-origin media at all.
 *
 * Every download writes into a manifest as it goes rather than only at the end, because a job
 * that dies halfway should still report the files it did save. `downloads_status` reads that
 * manifest, so a restart does not erase the record of what already landed on disk.
 */
import { createWriteStream, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import { fetchPost, fetchProfile, fetchPosts, fetchStories } from './ig.mjs'
import { startJob, getJob, listJobs, jobStatus } from './jobs.mjs'
import { exportDir } from './csv.mjs'

/** Extension to save a CDN URL under, given that fbcdn paths often hide theirs in a query. */
const extensionFor = url => {
  const fromPath = url.match(/\.(jpe?g|png|webp|mp4|mov)(?:$|[?#])/i)?.[1]
  if (fromPath) return fromPath.toLowerCase()
  return /[?&]itag=\d+|\.mp4/i.test(url) ? 'mp4' : 'jpg'
}

/** A folder name safe on every OS the agent might run on. */
const safeName = name => String(name).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'download'

/**
 * Streams one CDN URL to disk.
 *
 * A `referer` is sent because some signed URLs check it, and the body is streamed rather than
 * buffered — a carousel of full-resolution reels does not fit comfortably in memory when the
 * next several hundred are queued behind it.
 */
const saveAsset = async (url, destPath) => {
  const response = await fetch(url, { headers: { referer: 'https://www.instagram.com/' } })
  if (!response.ok) throw new Error(`CDN returned HTTP ${response.status}`)
  if (!response.body) throw new Error('CDN returned an empty body')
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath))
  return destPath
}

/** Collects the downloadable URLs of one shaped post, in carousel order, cover first. */
const assetsOf = post => {
  const frames = post.children?.length ? post.children : [post]
  const assets = []
  frames.forEach((frame, index) => {
    const position = post.children?.length ? `-${index + 1}` : ''
    frame.videos?.forEach(video => assets.push({ url: video.url, kind: 'video', position }))
    frame.images?.forEach(image => assets.push({ url: image.url, kind: 'image', position }))
  })
  return assets
}

export const downloadsStart = (session, params = {}) => {
  const { username = null, url = null, media = null, limit = null } = params

  if (username && url) throw new Error('`username` and `url` are mutually exclusive')
  if (!username && !url) throw new Error('Give either `url` (one post) or `username` (an account)')

  const wanted = media?.length ? new Set(media) : new Set(['posts', 'stories', 'highlights', 'reels'])
  const cap = limit === null || limit === undefined ? null : Math.max(1, Number(limit) || 1)

  return startJob('download', username ?? url, async job => {
    const folder = join(exportDir(), 'downloads', safeName(username ?? url))
    mkdirSync(folder, { recursive: true })
    // Recorded on the job itself so cancel removes exactly this folder rather than
    // re-deriving it from the label and hoping the naming rule has not changed since.
    job.folder = folder

    const manifestPath = join(folder, 'manifest.json')
    const manifest = {
      source: { username, url },
      folder,
      startedOn: new Date().toISOString(),
      finishedOn: null,
      saved: [],
      failed: [],
      skipped: [],
    }
    const flush = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    flush()

    /** Downloads one post's assets, recording successes and failures individually. */
    const savePost = async (post, kind) => {
      const assets = assetsOf(post)
      if (!assets.length) {
        manifest.skipped.push({ id: post.id, reason: 'no downloadable media' })
        flush()
        return
      }

      for (const asset of assets) {
        if (job.cancelled) return
        const name = `${safeName(post.shortcode ?? post.id)}${asset.position}.${extensionFor(asset.url)}`
        try {
          await saveAsset(asset.url, join(folder, name))
          manifest.saved.push({ file: name, kind, postId: post.id, shortcode: post.shortcode })
          flush()
        } catch (error) {
          manifest.failed.push({
            file: name,
            postId: post.id,
            reason: String(error?.message ?? error),
          })
          flush()
        }
      }
    }

    job.step = 'resolving source'
    flush()

    if (url) {
      const post = await fetchPost(session, { url })
      job.total = assetsOf(post).length
      job.step = `downloading ${post.shortcode ?? post.id}`
      await savePost(post, 'post')
    } else {
      // Stories are fetched first while they still exist: they expire on their own schedule,
      // so a pass that collected the grid first could come back to nothing.
      if (wanted.has('stories')) {
        job.step = 'reading stories'
        try {
          const stories = await fetchStories(session, username)
          job.total = stories.stories.length
          for (const story of stories.stories) {
            if (job.cancelled) break
            if (!story.url) continue
            const name = `story-${safeName(story.id)}.${extensionFor(story.url)}`
            try {
              await saveAsset(story.url, join(folder, name))
              manifest.saved.push({ file: name, kind: 'story', storyId: story.id })
            } catch (error) {
              manifest.failed.push({ file: name, storyId: story.id, reason: String(error?.message ?? error) })
            }
            job.done += 1
            job.step = `downloading stories (${job.done})`
            flush()
          }
        } catch (error) {
          // Not fatal: a username with no active stories answers this way, and refusing the
          // whole job because of it would be the wrong shape of failure.
          manifest.skipped.push({ kind: 'stories', reason: String(error?.message ?? error) })
          flush()
        }
      }

      if (job.cancelled) return

      if (wanted.has('posts') || wanted.has('reels')) {
        job.step = 'listing posts'
        const collected = []
        let cursor = null

        // Paged here rather than handed to `fetchPosts` once: a full-account download needs
        // every page, and the cap has to apply to the total rather than to each request.
        for (;;) {
          const page = await fetchPosts(session, username, cap ? Math.min(50, cap - collected.length) : 50, cursor)
          collected.push(...page.posts)
          cursor = page.nextCursor
          if (!cursor || (cap && collected.length >= cap)) break
          if (job.cancelled) return
        }

        const posts = cap ? collected.slice(0, cap) : collected
        job.total = posts.length
        job.step = `downloading ${posts.length} posts`

        for (let index = 0; index < posts.length; index += 1) {
          if (job.cancelled) return
          job.done = index + 1
          job.step = `downloading posts (${job.done}/${posts.length})`
          await savePost(posts[index], 'post')
        }
      }
    }

    manifest.finishedOn = new Date().toISOString()
    flush()

    job.result = {
      folder,
      manifestPath,
      saved: manifest.saved.length,
      failed: manifest.failed.length,
      skipped: manifest.skipped.length,
      items: manifest.saved,
    }
  })
}

export const downloadsStatus = ({ jobId = null } = {}) => {
  if (jobId) {
    const job = getJob(jobId)
    if (!job) {
      return { jobId, state: 'not-found', note: 'No such job in this driver. Job ids do not survive a restart.' }
    }
    return { ...jobStatus(job), result: job.result, error: job.error }
  }

  const jobs = listJobs('download')
  return {
    count: jobs.length,
    jobs: jobs.map(job => ({
      ...jobStatus(job),
      folder: job.result?.folder ?? null,
      saved: job.result?.saved ?? null,
      failed: job.result?.failed ?? null,
      manifestPath: job.result?.manifestPath ?? null,
    })),
    note: jobs.length ? null : 'No download has been started.',
  }
}

export const downloadsCancel = ({ jobId = null } = {}) => {
  if (!jobId) throw new Error('`jobId` is required')

  const job = getJob(jobId)
  if (!job) return { cancelled: false, state: 'not-found', note: 'No such job in this driver.' }
  if (job.state !== 'running') return { cancelled: false, state: job.state, note: 'That job has already finished.' }

  job.cancelled = true
  job.state = 'cancelled'
  job.finishedOn = new Date().toISOString()

  // "Deletes its saved data" — the whole folder, since a half-downloaded set is of no use to
  // anyone and leaving 40 MB of fragments behind is worse than removing them.
  const folder = job.folder ?? join(exportDir(), 'downloads', safeName(job.label))
  let removed = false
  if (existsSync(folder)) {
    rmSync(folder, { recursive: true, force: true })
    removed = true
  }

  return { cancelled: true, jobId, state: 'cancelled', removedFolder: removed, folder }
}
