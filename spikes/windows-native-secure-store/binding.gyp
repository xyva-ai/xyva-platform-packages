{
  "targets": [{
    "target_name": "windows_native_secure_store",
    "sources": ["src/windows_native_secure_store.cc"],
    "defines": ["NAPI_VERSION=8", "UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN"],
    "conditions": [["OS=='win'", { "libraries": ["-ladvapi32", "-lntdll"], "msvs_settings": { "VCCLCompilerTool": { "AdditionalOptions": ["/W4", "/WX", "/EHsc"] } } }]]
  }, {
    "target_name": "windows_native_secure_store_test",
    "sources": ["src/windows_native_secure_store.cc"],
    "defines": ["NAPI_VERSION=8", "UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "XYVA_TEST_BUILD=1"],
    "conditions": [["OS=='win'", { "libraries": ["-ladvapi32", "-lntdll"], "msvs_settings": { "VCCLCompilerTool": { "AdditionalOptions": ["/W4", "/WX", "/EHsc"] } } }]]
  }]
}
