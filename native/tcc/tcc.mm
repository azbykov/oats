// Checks and requests macOS privacy permissions that Electron has no API for —
// here "Audio Capture" (system audio via Core Audio Tap). TCC only shows its
// prompt when the request comes from the app process itself, so this runs inside
// Electron's main process. Notion's mac_utils.node does the same.
#import <Foundation/Foundation.h>
#include <dlfcn.h>
#include <node_api.h>

typedef int (*PreflightFn)(CFStringRef, CFDictionaryRef);
typedef void (*RequestFn)(CFStringRef, CFDictionaryRef, void (^)(BOOL));

static void *Symbol(const char *name) {
  static void *tcc = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW);
  return tcc ? dlsym(tcc, name) : NULL;
}

static CFStringRef ServiceArg(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char buf[128] = {0};
  size_t len = 0;
  if (argc < 1 || napi_get_value_string_utf8(env, argv[0], buf, sizeof(buf), &len) != napi_ok) return NULL;
  return CFStringCreateWithCString(NULL, buf, kCFStringEncodingUTF8);
}

// preflight(service) -> "granted" | "denied" | "not-determined" | "unknown"
static napi_value Preflight(napi_env env, napi_callback_info info) {
  const char *result = "unknown";
  CFStringRef service = ServiceArg(env, info);
  PreflightFn fn = (PreflightFn)Symbol("TCCAccessPreflight");
  if (service && fn) {
    int status = fn(service, NULL);
    result = status == 0 ? "granted" : status == 1 ? "denied" : "not-determined";
  }
  if (service) CFRelease(service);
  napi_value out;
  napi_create_string_utf8(env, result, NAPI_AUTO_LENGTH, &out);
  return out;
}

static void ResolveOnJsThread(napi_env env, napi_value, void *context, void *data) {
  napi_deferred deferred = (napi_deferred)context;
  napi_value value;
  napi_get_boolean(env, (bool)(intptr_t)data, &value);
  napi_resolve_deferred(env, deferred, value);
}

// request(service) -> Promise<boolean>; shows the system prompt if not decided yet
static napi_value Request(napi_env env, napi_callback_info info) {
  napi_deferred deferred;
  napi_value promise;
  napi_create_promise(env, &deferred, &promise);

  CFStringRef service = ServiceArg(env, info);
  RequestFn fn = (RequestFn)Symbol("TCCAccessRequest");
  if (!service || !fn) {
    napi_value no;
    napi_get_boolean(env, false, &no);
    napi_resolve_deferred(env, deferred, no);
    if (service) CFRelease(service);
    return promise;
  }

  napi_value name;
  napi_create_string_utf8(env, "tccRequest", NAPI_AUTO_LENGTH, &name);
  napi_threadsafe_function tsfn;
  napi_create_threadsafe_function(env, NULL, NULL, name, 0, 1, NULL, NULL, deferred, ResolveOnJsThread, &tsfn);
  fn(service, NULL, ^(BOOL granted) {
    napi_call_threadsafe_function(tsfn, (void *)(intptr_t)granted, napi_tsfn_blocking);
    napi_release_threadsafe_function(tsfn, napi_tsfn_release);
  });
  CFRelease(service);
  return promise;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "preflight", NAPI_AUTO_LENGTH, Preflight, NULL, &fn);
  napi_set_named_property(env, exports, "preflight", fn);
  napi_create_function(env, "request", NAPI_AUTO_LENGTH, Request, NULL, &fn);
  napi_set_named_property(env, exports, "request", fn);
  return exports;
}
