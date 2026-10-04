/**
 * `video_setup` — provisioning: fetch what the rest of the plugin needs.
 *
 * Split out of `video_env` because the two answer different questions and carry different
 * risk: `video_env` is read-only and free, while everything here downloads tens to hundreds
 * of megabytes, needs the network, and some of the actions remove an installation. Keeping
 * them in one action list made "check the machine" and "install a 300MB toolchain" adjacent
 * choices, which is exactly the kind of adjacency that produces an accidental download.
 *
 * Two installers have left this tool as their capability left the plugin. The offline OCR engine
 * went to `dsh-ocr` (`text_setup {action:"install"}`), and the YAMNet model plus the shared ONNX
 * runtime went to `dsh-video-audio` (`audio_setup {action:"install"}`). What remains installs
 * ffmpeg and the matting model — and the matting model borrows the runtime the audio plugin
 * installs, which is why installing matte before audio now fails with an instruction instead of
 * downloading a model that could not load.
 *
 * @module video-factory/tools/setup
 */
import { CWD_PROPERTY, defineFamilyTool } from './shared.mjs'

export const SETUP_TOOL_NAME = 'video_setup'

/** Every action this family exposes, in dispatch order. */
export const SETUP_ACTIONS = ['install_ffmpeg', 'install_matte']

/**
 * Build the `video_setup` tool.
 *
 * @param {Record<string, Function>} available - the environment action map; the installers are
 *   taken from it so the implementation stays in one place.
 * @returns {object} the tool definition.
 */
export function createSetupTool(available) {
  const handlers = Object.fromEntries(SETUP_ACTIONS.map((action) => [action, available[action]]))
  return defineFamilyTool({
    name: SETUP_TOOL_NAME,
    actions: SETUP_ACTIONS,
    extraProperties: {
      force: {
        type: 'boolean',
        description:
          'install_ffmpeg / install_matte: reinstall even when a copy is already present. For ffmpeg this is also the only way out of a half-unpacked vendor/ffmpeg/bin directory, which otherwise makes every later call skip the install.',
      },
      archive: {
        type: 'string',
        description:
          'install_matte: use a local U²-Net .onnx instead of downloading it. Use it when the host serving the file is slow or blocked: the file arrives by whatever means and its pinned SHA-256 is still checked. Resolved against the process working directory, not against "cwd".',
      },
      remove: {
        type: 'boolean',
        description: 'install_matte: remove the matting model instead of installing it. There is no removal for ffmpeg.',
      },
      cwd: CWD_PROPERTY,
    },
    handlers,
  })
}
