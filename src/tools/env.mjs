/**
 * `video_env` — environment self-check, canvas presets, and material inventory.
 *
 * The three actions answer "can I work here at all?", "what shapes can I produce?",
 * and "what raw material do I have?". None of them decide anything: `scan` reports
 * duplicates as facts and never drops them, because which still to use is a
 * creative choice that belongs to DSH.
 *
 * @module video-factory/tools/env
 */
import { CWD_PROPERTY, defineFamilyTool } from './shared.mjs'

export const ENV_TOOL_NAME = 'video_env'

export function createEnvTool(actions) {
  return defineFamilyTool({
    name: ENV_TOOL_NAME,
    description:
      'video-factory environment and material inventory. Use it before any other video_* tool to confirm ffmpeg is available, and to turn a material folder into a structured list before deciding what the video should contain.',
    actionsHelp:
      'probe: report ffmpeg/ffprobe paths and versions, available encoders and filters, Edge TTS reachability, and whether an Ark API key is present. ' +
      'presets: list the canvas presets (vertical-short, horizontal, square, landscape-4k, preview). ' +
      'scan: inventory a material folder — every image, video, and audio file with its probe metadata, near-duplicate stills marked (not removed), and unsupported files skipped. ' +
      'This never picks, ranks, or drops material; choosing is yours. ' +
      'install_ffmpeg: download a pinned ffmpeg static build into vendor/ when "probe" reports it missing. Needs the network and a few hundred megabytes.',
    actions: ['probe', 'presets', 'scan', 'install_ffmpeg'],
    extraProperties: {
      root: { type: 'string', description: 'Material folder to inventory. Required for "scan".' },
      recursive: { type: 'boolean', description: 'scan: descend into subdirectories. Defaults to true.' },
      dedupe: {
        type: 'boolean',
        description:
          'scan: compute perceptual hashes and mark near-duplicate stills. Defaults to true. Duplicates are reported via "duplicateOf", never removed.',
      },
      force: {
        type: 'boolean',
        description: 'install_ffmpeg: reinstall even when a vendored build is already present.',
      },
      cwd: CWD_PROPERTY,
    },
    handlers: actions,
  })
}
