/**
 * Optional darwin-only native addon (native/camera-effects). Declared here
 * because it is absent on Windows/Linux and on macs without build tools -
 * camera-effects.ts imports it dynamically and degrades gracefully.
 */
declare module 'openloom-camera-effects' {
  import type { CameraEffectsStatus } from '@shared/types';
  export function status(): CameraEffectsStatus;
  export function showVideoEffectsPanel(): void;
}
