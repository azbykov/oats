{
  "targets": [
    {
      "target_name": "oats_tcc",
      "sources": ["tcc.mm"],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "13.0",
        "OTHER_LDFLAGS": ["-framework", "Foundation"]
      }
    }
  ]
}
