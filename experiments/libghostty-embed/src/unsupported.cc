#include <node_api.h>

namespace {

napi_value Init(napi_env env, napi_value exports) {
  napi_throw_error(
      env,
      "ERR_GHOSTTY_EMBED_UNSUPPORTED",
      "Full libghostty embedding is currently implemented only for Darwin");
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
