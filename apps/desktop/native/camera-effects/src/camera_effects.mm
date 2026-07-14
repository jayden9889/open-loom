// macOS system camera effects bridge. The effects themselves (Portrait,
// Studio Light, Reactions) are applied by macOS inside the camera pipeline
// and are strictly user-controlled via Control Center - apps can only READ
// the global toggles (AVCaptureDevice class properties, no camera permission
// needed) and present the system Video Effects UI. Availability per Apple
// docs: Portrait 12.0+, Studio Light 13.0+, Reactions 14.0+,
// showSystemUserInterface 12.0+ (main queue).
#include <napi.h>
#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>

static Napi::Value GetCameraEffectsState(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);
  bool supported = false, portrait = false, studio = false, reactions = false;

  if (@available(macOS 12.0, *)) {
    supported = true;
    portrait = [AVCaptureDevice isPortraitEffectEnabled];
  }
  if (@available(macOS 13.0, *)) {
    studio = [AVCaptureDevice isStudioLightEnabled];
  }
  if (@available(macOS 14.0, *)) {
    reactions = [AVCaptureDevice reactionEffectsEnabled];
  }

  out.Set("supported", Napi::Boolean::New(env, supported));
  out.Set("portrait", Napi::Boolean::New(env, portrait));
  out.Set("studioLight", Napi::Boolean::New(env, studio));
  out.Set("reactions", Napi::Boolean::New(env, reactions));
  return out;
}

// Opens the Control Center "Video Effects" popover. Fire-and-forget; must
// run on the main thread. Returns false when the OS is too old.
static Napi::Value ShowVideoEffectsUI(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (@available(macOS 12.0, *)) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [AVCaptureDevice showSystemUserInterface:AVCaptureSystemUserInterfaceVideoEffects];
    });
    return Napi::Boolean::New(env, true);
  }
  return Napi::Boolean::New(env, false);
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getCameraEffectsState", Napi::Function::New(env, GetCameraEffectsState));
  exports.Set("showVideoEffectsUI", Napi::Function::New(env, ShowVideoEffectsUI));
  return exports;
}

NODE_API_MODULE(openloom_camera_effects, Init)
