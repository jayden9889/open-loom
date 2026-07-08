/**
 * Best-effort preview generation (thumbnail + gif + waveform), extracted pure
 * so it is unit-testable. These steps run AFTER video.mp4 has been written and
 * validated; a failure in any of them (a corrupt waveform pass, an OOM on a
 * long recording, a gif hiccup) must NEVER destroy the good recording. Each
 * step is therefore isolated and swallowed here, so it can never bubble up into
 * the caller's cleanup path and delete a valid video.
 */
export interface PreviewSteps {
  thumbnail(): Promise<void>;
  gif(): Promise<void>;
  waveform(): Promise<void>;
  warn(msg: string): void;
}

/**
 * Run every preview step, isolating each so one failure never aborts the
 * others and never throws. Always resolves.
 */
export async function generatePreviews(steps: PreviewSteps): Promise<void> {
  try {
    await steps.thumbnail();
  } catch (err) {
    steps.warn(`thumbnail generation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await steps.gif();
  } catch (err) {
    steps.warn(`gif preview generation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await steps.waveform();
  } catch (err) {
    steps.warn(`waveform generation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
