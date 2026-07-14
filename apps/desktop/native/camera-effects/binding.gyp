{
  "targets": [
    {
      "target_name": "openloom_camera_effects",
      "conditions": [
        ['OS=="mac"', {
          "sources": [ "src/camera_effects.mm" ],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")"
          ],
          "libraries": [
            "-framework Foundation",
            "-framework AVFoundation"
          ],
          "defines": [ "NAPI_VERSION=8" ],
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_CPLUSPLUSFLAGS": [ "-std=c++17" ]
          }
        }, {
          "type": "none"
        }]
      ]
    }
  ]
}
