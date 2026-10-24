{
  "targets": [{
    "target_name": "xyva_windows_secure_store",
    "sources": ["src/windows_secure_store.cc"],
    "defines": ["NAPI_VERSION=8", "UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN"],
    "conditions": [["OS=='win'", {
      "libraries": ["-ladvapi32", "-lntdll"],
      "msvs_settings": { "VCCLCompilerTool": { "AdditionalOptions": ["/W4", "/WX", "/EHsc"] } }
    }]]
  }]
}
