// Thin bridge against the pinned sherpa-onnx 1.13.8 C header.
// The native engine runs inside the reader; no Python or listening server.
#define SHERPA_ONNX_BUILD_SHARED_LIBS
#include "vendor/sherpa-onnx-c-api.h"
#include <exception>
#include <string>

static thread_local std::string last_error;
#define EXPORT extern "C" __declspec(dllexport)
EXPORT const char* TrKokoroVersion() { return SherpaOnnxGetVersionStr(); }
EXPORT const char* TrKokoroError() { return last_error.c_str(); }

EXPORT const SherpaOnnxOfflineTts* TrKokoroCreate(const char* directory) {
  last_error.clear();
  try {
    const std::string root(directory);
    const auto model = root + "/model.int8.onnx";
    const auto voices = root + "/voices.bin";
    const auto tokens = root + "/tokens.txt";
    const auto data = root + "/espeak-ng-data";
    const auto dict = root + "/dict";
    const auto lexicon = root + "/lexicon-us-en.txt," + root + "/lexicon-zh.txt";
    const auto rules = root + "/date-zh.fst," + root + "/phone-zh.fst," + root + "/number-zh.fst";
    SherpaOnnxOfflineTtsConfig config{};
    config.model.kokoro.model = model.c_str();
    config.model.kokoro.voices = voices.c_str();
    config.model.kokoro.tokens = tokens.c_str();
    config.model.kokoro.data_dir = data.c_str();
    config.model.kokoro.dict_dir = dict.c_str();
    config.model.kokoro.lexicon = lexicon.c_str();
    config.model.kokoro.lang = "zh";
    config.model.kokoro.length_scale = 1;
    config.model.num_threads = 2;
    config.model.provider = "cpu";
    config.rule_fsts = rules.c_str();
    config.max_num_sentences = 1;
    config.silence_scale = 1;
    auto engine = SherpaOnnxCreateOfflineTts(&config);
    if (!engine) last_error = "Kokoro initialization failed";
    return engine;
  } catch (const std::exception& e) { last_error = e.what(); }
  catch (...) { last_error = "Kokoro initialization failed"; }
  return nullptr;
}
EXPORT void TrKokoroDestroy(const SherpaOnnxOfflineTts* engine) {
  if (engine) SherpaOnnxDestroyOfflineTts(engine);
}
using Continue = int32_t (*)(void*);
struct Callback { Continue proceed; void* context; };
static int32_t Progress(const float*, int32_t, float, void* opaque) {
  auto callback = static_cast<Callback*>(opaque);
  return callback->proceed ? callback->proceed(callback->context) : 1;
}
EXPORT const SherpaOnnxGeneratedAudio* TrKokoroGenerate(
    const SherpaOnnxOfflineTts* engine, const char* text, int32_t speaker,
    Continue proceed, void* context) {
  last_error.clear();
  try {
    SherpaOnnxGenerationConfig config{};
    config.sid = speaker;
    config.speed = 1;
    config.silence_scale = 1;
    Callback callback{proceed, context};
    return SherpaOnnxOfflineTtsGenerateWithConfig(engine, text, &config, Progress, &callback);
  } catch (const std::exception& e) { last_error = e.what(); }
  catch (...) { last_error = "Kokoro generation failed"; }
  return nullptr;
}
EXPORT void TrKokoroFreeAudio(const SherpaOnnxGeneratedAudio* audio) {
  if (audio) SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
}
