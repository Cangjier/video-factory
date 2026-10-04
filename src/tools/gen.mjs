/**
 * `video_gen` — cloud footage generation via ByteDance's Volcengine Ark.
 *
 * Two actions only. There is deliberately no per-provider abstraction, because
 * only one provider exists here, and no "plan rewriting" step, because deciding
 * which scenes need generated footage is a creative choice.
 *
 * This is the only tool that does not satisfy "same input, same output": the same
 * prompt yields a different clip. It is an executor, not a deterministic operator,
 * and its description says so.
 *
 * `generate` submits, polls, and downloads in one call. It must finish the job
 * itself because the result URL is a presigned TOS link that expires in 24 hours;
 * handing a URL back to the caller risks losing the footage.
 *
 * @module video-factory/tools/gen
 */
import { CWD_PROPERTY, defineFamilyTool } from './shared.mjs'

export const GEN_TOOL_NAME = 'video_gen'

export function createGenTool(actions) {
  return defineFamilyTool({
    name: GEN_TOOL_NAME,
    actions: ['models', 'generate', 'image_models', 'image'],
    extraProperties: {
      prompt: { type: 'string', description: 'generate / image: the creative direction. For image, describe the picture you want.' },
      imagePrompt: { type: 'string', description: 'image: alias for prompt, when generating an image and a video prompt is also in play.' },
      imageSize: {
        type: 'string',
        description:
          'image: output size, either a preset such as "1k" or "2K", or "WIDTHxHEIGHT" such as "1024x1024". The image area must be between 921600 and 4624220 pixels; a size outside that is refused before anything is generated.',
      },
      imageCount: {
        type: 'integer',
        description: 'image: reserved. The current models return one image per request, so ask again for another rather than raising this.',
      },
      mode: {
        type: 'string',
        enum: ['text-to-video', 'image-to-video', 'first-last-frame'],
        description: 'generate: text-to-video, image-to-video from one reference frame, or interpolate between two frames.',
      },
      reference: { type: 'string', description: 'generate: first-frame image, local path or public URL. Required for image modes.' },
      lastFrame: { type: 'string', description: 'generate: last-frame image for mode "first-last-frame".' },
      duration: { type: 'integer', description: 'generate: seconds. Legal range is per model — Seedance 2.0 accepts 4 to 15.' },
      resolution: { type: 'string', enum: ['480p', '720p', '1080p', '4k'], description: 'generate: output resolution.' },
      ratio: {
        type: 'string',
        enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'],
        description: 'generate: aspect ratio. Use "adaptive" to follow the reference image.',
      },
      model: { type: 'string', description: 'generate: override the default model id. Do not use a shut-down id — check "models" first.' },
      imageModel: {
        type: 'string',
        description: 'image: override the default image model id. Do not use a shut-down id — check "image_models" first.',
      },
      seed: { type: 'integer', description: 'generate: -1 for random. A fixed seed makes the result approximately reproducible.' },
      generateAudio: { type: 'boolean', description: 'generate: ask the model for synchronized audio, where the model supports it.' },
      draft: { type: 'boolean', description: 'generate: request a cheaper low-resolution draft, where the model supports it.' },
      serviceTier: {
        type: 'string',
        description:
          'generate: request a service tier such as "flex" (offline queue, cheaper, slower). Only some models accept it and Seedance 2.0 rejects it outright — omit it unless "models" reports it is supported.',
      },
      returnLastFrame: { type: 'boolean', description: 'generate: also return the final frame, so the next shot can continue from it.' },
      cameraFixed: { type: 'boolean', description: 'generate: hold the camera still.' },
      watermark: { type: 'boolean', description: 'generate: keep the provider watermark. Defaults to true, which also satisfies the AI-content labelling duty.' },
      outDir: { type: 'string', description: 'generate: directory for the downloaded clip. Defaults to "generated" beside the plan.' },
      sceneId: { type: 'string', description: 'generate: name the output file after this scene id, for example s07.mp4.' },
      pollIntervalSeconds: { type: 'integer', description: 'generate: seconds between status polls. Defaults to 15.' },
      maxWaitSeconds: { type: 'integer', description: 'generate: give up after this long. Defaults to 900.' },
      cwd: CWD_PROPERTY,
    },
    handlers: actions,
  })
}
