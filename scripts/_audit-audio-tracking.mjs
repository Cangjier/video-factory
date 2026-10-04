/**
 * Which audio files are newer than the last commit, and which are committed?
 *
 * `git ls-files` cannot answer this — several of these files were never committed — so the two
 * states are compared directly: the working tree (`src/…`, `tests/…`) against `git show HEAD:…`.
 * A file whose content differs from HEAD, or that HEAD does not contain at all, has content that
 * only exists in the working tree. Those are the ones worth recovering before anything else.
 */
import { execFileSync } from 'node:child_process'

const paths = [
  'src/core/audio-build.mjs',
  'src/core/audio-integrity.mjs',
  'src/core/audio-restore.mjs',
  'src/core/audio-record.mjs',
  'src/core/audio-signal.mjs',
  'src/core/audio-measure.mjs',
  'src/core/audio-events.mjs',
  'src/core/audio-install.mjs',
  'src/tools/audio.mjs',
  'src/tools/audio-actions.mjs',
  'tests/audio-build.test.mjs',
  'tests/audio-integrity.test.mjs',
  'tests/audio-restore.test.mjs',
  'tests/audio-signal.test.mjs',
  'tests/audio-actions.test.mjs',
  'tests/audio.test.mjs',
  'tests/audio-engine.test.mjs',
]

for (const path of paths) {
  let committed = null
  try {
    committed = execFileSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    committed = null
  }
  console.log(`${committed === null ? 'UNTRACKED ' : 'tracked   '} ${path} (${committed?.length ?? 0} bytes at HEAD)`)
}
