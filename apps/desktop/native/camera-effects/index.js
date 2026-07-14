// Shapes the native exports to the app's CameraEffectsStatus contract.
// Callers guard the require in try/catch: the whole package is an OPTIONAL
// darwin-only dependency and the app must keep working without it.
const native = require('bindings')('openloom_camera_effects');

module.exports = {
  /** @returns {{ supported: boolean, portrait: boolean, studioLight: boolean, reactions: boolean }} */
  status() {
    return native.getCameraEffectsState();
  },
  showVideoEffectsPanel() {
    native.showVideoEffectsUI();
  },
};
