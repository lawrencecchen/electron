{
  "variables": {
    "ghostty_xcframework%": "<!(node -p \"process.env.GHOSTTY_XCFRAMEWORK || ''\")"
  },
  "targets": [
    {
      "target_name": "libghostty_embed",
      "conditions": [
        ["OS=='mac'", {
          "sources": ["src/libghostty_embed.mm"],
          "defines": ["GHOSTTY_STATIC=1"],
          "include_dirs": [
            "<(ghostty_xcframework)/macos-arm64_x86_64/Headers"
          ],
          "libraries": [
            "<(ghostty_xcframework)/macos-arm64_x86_64/ghostty-internal.a",
            "-lc++",
            "-framework Cocoa",
            "-framework Metal",
            "-framework QuartzCore",
            "-framework IOSurface",
            "-framework UniformTypeIdentifiers",
            "-framework Carbon"
          ],
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
            "MACOSX_DEPLOYMENT_TARGET": "13.0"
          }
        }],
        ["OS!='mac'", {
          "sources": ["src/unsupported.cc"]
        }]
      ]
    }
  ]
}
