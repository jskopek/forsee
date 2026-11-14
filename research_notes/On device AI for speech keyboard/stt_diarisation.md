# On-device speech-to-text, speaker diarisation and speaker identification (state as of November 2026)

Verification legend used throughout:
- **[P]** = read directly from a primary source in this session (GitHub README / repo docs).
- **[S]** = taken from a web-search extract of the cited page; the page itself could NOT be opened from this environment (arxiv.org, huggingface.co, docs.fluidinference.com, soniqo.audio, daily.co, developers.googleblog.com and most vendor/blog hosts were blocked). Treat [S] numbers as "reported, not verified against the primary table".
- RTFx = audio seconds processed per wall-clock second (higher is faster). RTF = the inverse (lower is faster). Sources mix both; each bullet says which.

## 1. Which open models and OS APIs give the best streaming transcription on-device in late 2026?

### Takeaway
For real-time English on-device, the strongest evidence points to three families: NVIDIA's cache-aware streaming FastConformer ("Nemotron Speech Streaming" 0.6B, plus Parakeet EOU/Unified variants), Moonshine v2 streaming models (34M–245M params, MIT, built for CPUs), and the OS recogniser on Apple platforms (SpeechAnalyzer). Large "speech-LLM" models that top the offline leaderboard (Qwen3-ASR, Granite Speech, Canary-Qwen, Voxtral Realtime 4B, Kyutai STT 1B/2.6B) are mostly too heavy or not truly streaming for tablets and GPU-less laptops; multilingual streaming remains weaker than English.

### Cited Findings

**Leaderboard context (offline accuracy, not streaming)**
- [S] An October 2026 snapshot of the Open ASR Leaderboard is reported as: Qwen3-ASR-1.7B about 5.40 average WER, Parakeet TDT v2 6.02, Whisper large-v3 7.16; Canary-Qwen 2.5B listed at 5.63 by another source; snapshots from different aggregators disagree. — [codesota leaderboard mirror](https://www.codesota.com/benchmark/open-asr-leaderboard); [benchmarklist](https://benchmarklist.com/benchmarks/open_asr_leaderboard/)
- [S] IBM Granite Speech 4.1 2B is reported at the top of the English leaderboard at 5.33% WER; Qwen3-ASR-0.6B 6.42%; Canary-1B-v2 7.15; Phi-4 Multimodal Instruct 6.02 (the last two from the Open ASR Leaderboard paper's table, which is older, Oct 2025). — [benchmarklist](https://benchmarklist.com/benchmarks/open_asr_leaderboard/); [Open ASR Leaderboard paper, arXiv 2510.06961](https://arxiv.org/html/2510.06961v2)
- [S] Licences reported by a model-comparison site: Qwen3-ASR (both sizes) Apache-2.0; Granite Speech 4.1 (all variants) Apache-2.0; Cohere Transcribe Apache-2.0; Canary-1B-v2 CC-BY-4.0. — [models.handy.computer](https://models.handy.computer/)
- [S] The leaderboard measures batch WER; practitioners note it scores streaming models with a batch test, and that some models were tuned on leaderboard training splits. — [codesota](https://codesota.com/speech-to-text)

**NVIDIA Nemotron Speech Streaming / streaming FastConformer (strongest English streaming candidate)**
- [S] Microsoft paper "Pushing the Limits of On-Device Streaming ASR" (arXiv 2604.14493, April 2026, Banfic et al.) compared Parakeet TDT, Canary, Qwen3-ASR and others in batch, chunked and streaming modes on CPU and concluded NVIDIA's Nemotron Speech Streaming (~600M params) was the strongest candidate for real-time English on-device use, with the best streaming WER and lowest latency of the models tested. — [arXiv 2604.14493](https://arxiv.org/abs/2604.14493v2); [Microsoft Research listing](https://www.microsoft.com/en-us/research/?p=1169047)
- [S] Same paper: int4 k-quant ONNX variant shrinks the model from 2.47 GB to 0.67 GB; average streaming WER across eight benchmarks 8.20% versus 8.03% for ONNX FP32; recommended streaming config (7,10,7) has 0.56 s algorithmic delay; all ONNX variants ran at RTFx > 6 on CPU (a secondary blog lists roughly 6.7 FP32, 7.25 int8, 7.20 int4). — [arXiv 2604.14493](https://arxiv.org/html/2604.14493v2); [themoonlight review](https://www.themoonlight.io/review/pushing-the-limits-of-on-device-streaming-asr-a-compact-high-accuracy-english-model-for-low-latency-inference)
- [S] Same paper: memory listed as 1.88 GB for Qwen3-ASR-0.6B and 6.36 GB for Canary-1B-v2; Qwen3-ASR-0.6B works in batch and chunked modes rather than true streaming. — [arXiv 2604.14493](https://arxiv.org/html/2604.14493v1)
- [S] Model card `nvidia/nemotron-speech-streaming-en-0.6b`: cache-aware streaming FastConformer encoder with RNN-T decoder, ~618M params, configurable chunk sizes 80/160/560/1120 ms. — [Hugging Face model card](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b); [mixpeek listing](https://mixpeek.com/model/nvidia/nemotron-speech-streaming-en-0.6b)
- [S] Licence CONFLICT: one set of sources says NVIDIA Open Model License; another says OpenMDW-1.1 for a model it calls "Nemotron 3.5 ASR". A 0.6B multilingual sibling covering "40 language-locale combinations" is listed by a hosting provider. Verify on the model card before shipping. — [mixpeek](https://mixpeek.com/model/nvidia/nemotron-speech-streaming-en-0.6b); [Together AI listing](https://together.ai/models/nvidia-nemotron-35-asr)
- [P] FluidAudio Core ML port, Nemotron Speech Streaming 0.6B English on Apple silicon (M5 Pro), LibriSpeech test-clean full set: 560 ms chunk 2.71% WER at 40.7x RTFx; 1120 ms chunk 2.58% at 24.3x; 2240 ms chunk 2.64% at 87.4x. — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md)
- [P] FluidAudio Nemotron Multilingual (M5 Pro, 2240 ms tier): LibriSpeech test-clean 3.2–3.6% WER; FLEURS en 8.96%, es 4.80%, fr 9.52%, it 5.41%, pt 6.14%, de 9.83% WER; zh 18.57% CER; ja 13.79% CER; 76–147x RTFx. — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md)
- [P] Memory on iOS for the Nemotron encoder: ~1.4 GB residency on the Neural Engine versus ~140 MB on CPU; encoder file 422 MB (6-bit) versus 564 MB (int8). — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md)
- [P] sherpa-onnx lists Nemotron streaming, Parakeet TDT v2/v3, Qwen3-ASR, Moonshine, Zipformer, SenseVoice, Paraformer and Whisper among supported models (Canary is not mentioned on the README). — [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)

**Parakeet family on Apple silicon (FluidAudio, Core ML / Neural Engine)**
- [P] Parakeet TDT v3 (25 European languages): LibriSpeech test-clean 2.5% average WER at ~156x RTFx on M4 Pro; FLEURS 25-language average 14.7% WER / 4.7% CER at ~210x. Parakeet TDT v2 (English): 2.1% WER at ~146x. — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md)
- [P] On M5 Pro: Parakeet v3 (~480 MB download) 2.27% test-clean / 4.12% test-other; "Parakeet Ultra" (~630 MB) 2.13% / 3.81%; "Phonon-2" (English, ~360 MB, iOS 18+) 2.47% / 4.62%; all ~140–160x RTFx on short files. On a 60-minute recording WER rises to 13.5–17.2%, which shows long-form conversational audio is much harder than LibriSpeech. — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md)
- [P] "Parakeet Unified" (one model, batch or streaming; M5 Pro, int8 encoder on ANE): batch 2.15% average WER at 123x; streaming 2.21% average WER at 29x. — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md)
- [P] Parakeet EOU (120M, English, built-in end-of-utterance token) on a 2022 M2: 320 ms chunks 4.88% WER at 19x RTFx; 160 ms chunks 8.23% WER at 5.8x. — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md)
- [P] Core ML first-load compile time for the Parakeet encoder: 3.4 s cold / 0.16 s warm on iPhone 16 Pro Max; 4.4 s cold on iPhone 13. — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md)
- [P] FluidAudio code is Apache-2.0; its README says models are MIT or Apache-2.0 "in general", but Sortformer is under the NVIDIA Open Model License and the Parakeet licence is not stated on the README. It ships a React Native/Expo wrapper (`@fluidinference/react-native-fluidaudio`) and a Rust/Tauri crate (`fluidaudio-rs`); a Windows "fluid-server" is described as in development. Latest version referenced: 0.17.7. — [FluidInference/FluidAudio](https://github.com/FluidInference/FluidAudio)
- [P] FluidAudio's README also lists newer ASR options not examined further here: Parakeet Redux (~220 MB), Phonon-2.5 (25 languages, ~290 MB), Bark 3.0 (English), "Nemotron 3.5 Transcribe Lite" and "LFM3-Audio-2B". — [FluidInference/FluidAudio](https://github.com/FluidInference/FluidAudio)

**Moonshine v2 (Useful Sensors / Moonshine AI)**
- [P] Benchmark table from the Moonshine README (as preserved in a fork; the current upstream README no longer shows the table): Medium Streaming 245M params, 6.65% WER, response latency 107 ms MacBook Pro / 269 ms Linux x86 / 802 ms Raspberry Pi 5; Small Streaming 123M, 7.84%, 73 / 165 / 527 ms; Tiny Streaming 34M, 12.00%, 34 / 69 / 237 ms. Comparison rows: Whisper large-v3 1.5B, 7.44%, 11,286 ms / 16,919 ms / N/A; Whisper small 8.59%, 1,940 / 3,425 / 10,397 ms; Whisper tiny 12.81%, 277 / 1,141 / 5,863 ms. — [moonshine README (fork copy)](https://github.com/thinhlpg/moonshine)
- [P] Methodology caveats: latency is time from VAD end-of-phrase to final text; Whisper was run with faster-whisper on CPU only; latency used a single test file; WER uses the Open ASR Leaderboard datasets. — [moonshine README (fork copy)](https://github.com/thinhlpg/moonshine)
- [P] Licence: code MIT; models MIT "in every language and at every size", EXCEPT legacy non-streaming models for non-English languages, which are under the non-commercial Moonshine Community License (enumerated in the repo LICENSE). — [moonshine-ai/moonshine](https://github.com/moonshine-ai/moonshine)
- [P] Streaming models are English only (Tiny/Small/Medium Streaming); Arabic, Japanese, Mandarin, Spanish, Ukrainian, Vietnamese have a non-streaming Base model and Korean a Tiny model (fork copy of README). The current upstream README lists STT languages English, Spanish, German, Mandarin, Japanese, Korean, Vietnamese, Tagalog, Ukrainian, Arabic. — [fork copy](https://github.com/thinhlpg/moonshine); [moonshine-ai/moonshine](https://github.com/moonshine-ai/moonshine)
- [P] Platforms: Python, JavaScript/WASM, iOS, Android, macOS, Linux, Windows, Raspberry Pi; bindings in Python, Swift, Java, C++ over a C core. The library has built-in VAD segmentation and an experimental `identify_speakers` option (on by default) that returns a per-line speaker ID and speaker index. — [moonshine-ai/moonshine](https://github.com/moonshine-ai/moonshine); [fork copy](https://github.com/thinhlpg/moonshine)
- [S] Moonshine v2 paper (arXiv 2602.12241, 12 Feb 2026, Kudlur, King, Wang, Warden): sliding-window self-attention, position-free "ergodic" streaming encoder; argues full-attention encoders (Whisper) have time-to-first-token that grows with utterance length. — [arXiv 2602.12241](https://arxiv.org/html/2602.12241)

**Kyutai STT (delayed streams modelling)**
- [P] Two models: `kyutai/stt-1b-en_fr` (English + French, ~1B params, 0.5 s delay, includes a semantic VAD) and `kyutai/stt-2.6b-en` (English, ~2.6B, 2.5 s delay). Word-level timestamps; experimental text/audio prompting. — [kyutai-labs/delayed-streams-modeling](https://github.com/kyutai-labs/delayed-streams-modeling)
- [P] Runtimes: PyTorch, Rust server, MLX (`moshi-mlx`) for Apple silicon, and `moshi-swift`; the 1B model "was tested on an iPhone 16 Pro". No on-device speed numbers are published in the repo. Licence: code MIT (Python) / Apache-2.0 (Rust); STT weights CC-BY 4.0. — [kyutai-labs/delayed-streams-modeling](https://github.com/kyutai-labs/delayed-streams-modeling)
- [S] One leaderboard list places Kyutai STT at 6.4% WER (offline). — [codesota](https://codesota.com/speech-to-text)

**Mistral Voxtral Realtime**
- [S] `mistralai/Voxtral-Mini-4B-Realtime-2602` (Feb 2026): 4B-parameter natively streaming model, 13 languages, Apache-2.0 open weights; configurable delay from 80 ms to 2.4 s; at 480 ms delay reported on par with offline Whisper and competitive with ElevenLabs Scribe v2 Realtime. — [arXiv 2602.11298](https://arxiv.org/html/2602.11298v2); [Mistral announcement](https://mistral.ai/fr/news/voxtral-transcribe-2)
- [S] Model card states BF16 weights need a single GPU with >= 16 GB memory, and that ExecuTorch on-device support "is not thoroughly tested"; community runs exist for MLX and a browser demo. — [alternativeto summary](https://alternativeto.net/news/2026/2/mistral-unveils-voxtral-transcribe-2-a-cheap-open-source-speech-model-that-runs-on-device); [pipeline explorer](https://shreyask-voxtral-pipeline-explorer.static.hf.space/index.html)

**Whisper family, WhisperKit / Argmax**
- [S] WhisperKit (MIT) from v1.0.0 (May 2026) ships inside the Argmax open-source Swift SDK `argmax-oss-swift` together with SpeakerKit and TTSKit; the Pro SDK is under a separate commercial "Argmax Standard License". — [argmax-oss-swift registry page](https://swiftpackageregistry.com/argmaxinc/argmax-oss-swift); [WhisperKit README mirror](https://cdn.jsdelivr.net/gh/argmaxinc/whisperkit@main/README.md)
- [S] WhisperKit README recommends the compressed large-v3-turbo (`large-v3-v20240930_626MB`) across iOS and macOS. The WhisperKit paper (arXiv 2507.10860, July 2025 — older) reports 0.46 s streaming latency matching the fastest cloud APIs with the best accuracy among those compared. — [WhisperKit README mirror](https://cdn.jsdelivr.net/gh/argmaxinc/whisperkit@main/README.md); [arXiv 2507.10860](https://arxiv.org/html/2507.10860v1)
- [P] Whisper is encoder-decoder over fixed windows, so CPU latency is poor: 11.3 s per phrase for large-v3 and 1.9 s for small on a MacBook Pro CPU via faster-whisper in Moonshine's test. — [moonshine README (fork copy)](https://github.com/thinhlpg/moonshine)

**Apple SpeechAnalyzer / SpeechTranscriber (iOS/macOS 26+)**
- [S] July 2026 benchmark by the developer of an on-device transcription app: SpeechAnalyzer 2.12% WER on LibriSpeech test-clean versus Whisper small 3.74%, base 5.42%, tiny 7.88%; on test-other 4.56% versus Whisper small 7.95%. — [Gigazine report](https://www.gigazine.net/gsc_news/en/20260714-apple-speech-analyzer-benchmark/)
- [S] A Mac dictation vendor's 40-speaker benchmark: SpeechAnalyzer 1.98% versus whisper.cpp small.en 4.28%. Both benchmarks come from vendors with a stake; neither independently replicated. — [dev.to benchmark](https://dev.to/iravoice/apple-speechanalyzer-vs-whispercpp-a-40-speaker-mac-benchmark-40i4)
- [S] Speed: 34-minute video transcribed in 45 s on an M2 Pro versus 101 s for Whisper large-v3-turbo; in a multilingual real-world test SpeechAnalyzer won German and Italian while WhisperKit won English and Spanish. — [developersdigest](https://www.developersdigest.tech/blog/apple-speechanalyzer-vs-whisper-benchmark); [rohitraj.tech note](https://rohitraj.tech/en/notes/apple-speechanalyzer-vs-whisper-on-device-stt-2026)
- [S] SpeechAnalyzer does not provide speaker diarisation; it must be added separately (single blog source). — [rohitraj.tech note](https://rohitraj.tech/en/notes/apple-speechanalyzer-vs-whisper-on-device-stt-2026)

**Android / Google**
- [S] ML Kit GenAI Speech Recognition API (alpha, `genai-speech-recognition:1.0.0-alpha1`): streams partial and final results from the microphone or an external stream. "Basic" mode uses the conventional on-device recogniser and is available on most devices with API level 31+; "Advanced" mode uses Gemini Nano via AICore and is currently limited to Pixel 10 devices. — [ML Kit docs](https://developers.google.com/ml-kit/genai/speech-recognition/android?hl=de)
- [S] Google blog dated 10 Nov 2026 (AI Edge Gallery): ML Kit's latest on-device speech models are described as multilingual across 100+ languages at 10x real-time; speech models are packaged as `.litertlm` and run on LiteRT; the reference architecture gives transcription to small speech models rather than to Gemma, even though Gemma 4 can take audio. A secondary write-up adds 8–9% WER on FLEURS (unverified). — [Google Developers Blog](https://developers.googleblog.com/on-device-speech-recognition-and-text-to-speech-in-google-ai-edge-gallery/); [hermes-ai.net summary](https://hermes-ai.net/news/google-brings-on-device-voice-to-ai-edge-gallery-with-100ms-startup/)
- [S] Gemma 3n was the first Google AI Edge model with audio input (MediaPipe LLM Inference API); that API is now maintenance-only and Google recommends LiteRT-LM. — [Google AI Edge LLM Inference guide](https://developers.google.com/edge/mediapipe/solutions/genai/llm_inference/android)
- [P] sherpa-onnx (Apache-2.0) runs on Android, iOS, HarmonyOS, Windows, macOS, Linux and WebAssembly, with NPU back ends for Qualcomm QNN, Rockchip RKNN, Ascend, Axera and Intel OpenVINO, and bindings for 12 languages including Kotlin, Swift, JavaScript/Node (`sherpa-onnx-node`), C#, Dart and Rust. — [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)

**Windows laptops without a discrete GPU**
- [S] Parakeet TDT 0.6B v3 int8 ONNX on desktop Intel CPUs: about 29.7x real time on an i7-12700KF and about 17x on a 2014 i7-4790; faster-whisper small int8 reached 7.6x on an i7-12700K; int8 reported with no accuracy loss on the project's own test set. — [parakeet-tdt-0.6b-v3-fastapi-openai](https://github.com/groxaxo/parakeet-tdt-0.6b-v3-fastapi-openai)
- [S] A cross-platform offline benchmark lists Parakeet TDT v2 via sherpa-onnx on a CPU-only Windows app at RTF 0.113 (about 1.2 s for an 11 s clip); device not identified in the extract. — [VoicePing offline transcription benchmark](https://voiceping-landingpage-prod.pages.dev/en/blog/research-offline-speech-transcription-benchmark/)
- [S] The NVIDIA ONNX exports are 631–680 MB int8 files that "run comfortably on any recent CPU via sherpa-onnx". — [openwhispr comparison](https://openwhispr.com/blog/parakeet-vs-whisper-vs-nemotron)
- [S] Nemotron streaming ONNX on CPU ran at RTFx > 6 in Microsoft's study (hardware not captured in the extract). — [arXiv 2604.14493](https://arxiv.org/html/2604.14493v2)

### Inferences
- Device-class recommendation implied by the evidence (not stated by any single source):
  - (a) Apple-silicon Mac: Parakeet/Nemotron via Core ML (FluidAudio) or SpeechAnalyzer; headroom is huge (25–150x real time), so ASR can share the machine with a local LLM.
  - (b) GPU-less Windows laptop: sherpa-onnx or ONNX Runtime on CPU with Nemotron streaming int4/int8 (6–7x real time reported) or Moonshine Small/Medium Streaming (165–269 ms response latency on "Linux x86"); Parakeet TDT v3 int8 in VAD-chunked mode for multilingual. No verified NPU numbers were found, so NPU should be treated as an optimisation, not the baseline.
  - (c) iPad/iPhone: SpeechAnalyzer (zero download, strong English WER) or FluidAudio Parakeet EOU / Nemotron; note the ~1.4 GB Neural Engine residency of Nemotron against the app memory limit on mid-range devices, which favours Parakeet EOU 120M or Moonshine there.
  - (d) Mid-range Android tablet: sherpa-onnx (streaming Zipformer, Moonshine, Nemotron int8) or the Moonshine Android library; the Raspberry Pi 5 figures (237–802 ms) are a reasonable lower bound for a mid-range ARM tablet CPU. ML Kit "Basic" mode is the OS fallback; "Advanced" (Gemini Nano) is Pixel 10 only.
- The MIT-licensed, English streaming Moonshine models are the cleanest licence fit for an MIT project; CC-BY-4.0 weights (Kyutai, Canary-1B-v2, typical Parakeet releases) require attribution but allow commercial distribution; NVIDIA Open Model License / OpenMDW and the Moonshine Community License need legal review before app-store shipping.
- LibriSpeech-class WER (2–3%) will not transfer to the use case: the same Parakeet models hit 13–17% WER on a 60-minute recording and Nemotron averages ~8% across eight benchmarks, so 10–20% WER on far-field household conversation is the realistic planning figure.
- Speech-LLM models (Voxtral Realtime 4B, Kyutai 2.6B, Granite, Phi-4-multimodal, Qwen3-ASR-1.7B) would compete for the same RAM as the reply-prediction LLM; a sub-1 GB dedicated ASR model is the more defensible architecture on tablets.

### Gaps
- Could not open any Hugging Face model card, so licences for Parakeet TDT v2/v3, Nemotron (NVIDIA Open Model License vs OpenMDW-1.1), Canary, Granite, Phi-4-multimodal and Qwen3-ASR are from secondary listings or unconfirmed.
- No verified numbers for Copilot+ NPUs (Snapdragon X, Intel/AMD NPU) running any of these models; no Qualcomm AI Hub figures retrieved.
- No measured RTF on a specific mid-range Android tablet or mid-range iPad for any model; Android figures are extrapolations from Raspberry Pi 5 and from the VoicePing benchmark that could not be opened.
- Streaming-mode WER tables for Moonshine v2, Kyutai and Voxtral on conversational sets (AMI, Earnings-22) were not retrievable (arXiv blocked).
- Whether Apple's iOS/macOS 27 changed SpeechAnalyzer (e.g. added speaker labels or custom vocabulary) is unknown; no source found.
- Phi-4-multimodal, Gemma 3n/Gemma 4 audio, and Granite Speech streaming behaviour on-device: no usable primary data found.

## 2. What works inside a web view (WebGPU / WASM) versus requiring native code?

### Takeaway
In-webview ASR is feasible for small models (Moonshine tiny/base, Whisper tiny/base, Parakeet via onnxruntime-web), and Parakeet 0.6B has been shown running faster than real time with WebGPU on desktop GPUs, but published numbers are self-reported, hardware-unspecified and inconsistent; WebGPU availability inside iOS WKWebView and Android WebView is the main risk. Native plugins/sidecars (Core ML, sherpa-onnx, ONNX Runtime) are the dependable path, with WASM as a fallback.

### Cited Findings
- [S] `parakeet.js` runs NVIDIA Parakeet ONNX models fully client-side through onnxruntime-web with WebGPU or WASM back ends. — [parakeet.js API docs](https://ysdede.github.io/parakeet.js/api/); [demo README](https://huggingface.co/spaces/ysdede/parakeet.js-demo/blob/main/README.md)
- [S] The author's "Keet" streaming app reports improvement from 6.3x to 19–27x real time, with per-chunk time falling from 787 ms to 187–265 ms (Jan–Feb 2026; hardware unspecified). — [ysdede/keet mirror](https://gh.r-mj.com/ysdede/keet)
- [S] A Parakeet TDT 0.6B v3 progressive-transcription browser demo reports RTF ~0.3–0.5 with WebGPU (i.e. only 2–3x real time). — [parakeet-v3-streaming README](https://huggingface.co/spaces/RobinsAIWorld/parakeet-v3-streaming/blob/main/README.md)
- [S] Transformers.js v4 (Feb 2026) is reported to have a new WebGPU runtime with 3–10x speed-ups over the v3 WASM back end; WebGPU is reported 5–10x faster than WASM for Whisper (secondary sources, not confirmed with Hugging Face). — [sitepoint](https://www.sitepoint.com/webgpu-vs-webasm-transformers-js/); [callsphere](https://callsphere.ai/blog/vw9e-webgpu-ai-inference-browser-voice-2026)
- [S] Moonshine tiny and base ONNX builds exist for transformers.js (`onnx-community`), with a `moonshine-web` WebGPU demo. — [moonshine-web README](https://huggingface.co/spaces/webml-community/moonshine-web/raw/main/README.md)
- [P] The Moonshine library itself lists JavaScript/WASM as a supported platform, and sherpa-onnx lists WebAssembly as a supported target. — [moonshine-ai/moonshine](https://github.com/moonshine-ai/moonshine); [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
- [S] Guidance for browsers: Whisper tiny (39M) for low-end and base (74M) for desktop; Whisper large works on a 16 GB+ desktop but with poor real-time latency. — [forasoft client-side ASR article](https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/client-side-asr-faster-whisper-wasm-browser)
- [S] Sources CONFLICT on Safari/iOS WebGPU: "experimental", "not supported as of 2026", and "works in iOS Safari since Safari 26 with tighter GPU memory limits"; a WASM/CPU fallback for iOS Safari is recommended. — [sitepoint](https://www.sitepoint.com/webgpu-vs-webasm-transformers-js/); [offlinetts](https://offlinetts.com/blog/browser-speech-recognition-whisper-comparison/); [forasoft cheat sheet](https://www.forasoft.com/learn/downloads/client-side-asr-browser-cheat-sheet)
- [S] Google's LiteRT.js offers WebGPU/WASM/WebNN back ends for running LiteRT models in the browser. — [xenospectrum](https://xenospectrum.com/en/google-litert-js-browser-ai-webgpu-wasm-webnn/)
- [S] A Cohere Transcribe WebGPU demo is reported at ~36x real time on a WebGPU-capable desktop GPU. — [themenonlab blog](https://themenonlab.blog/blog/cohere-transcribe-webgpu-browser-speech-recognition)

### Inferences
- Electron (Chromium) can use WebGPU for ASR, but on a GPU-less laptop the integrated GPU is shared with rendering and any WebGPU LLM; a sidecar process using sherpa-onnx/ONNX Runtime on CPU threads (or `sherpa-onnx-node` in the main process) avoids contention and gives predictable latency.
- In Capacitor, the web view should be treated as UI only: capture audio and run ASR/diarisation in a native plugin (FluidAudio or SpeechAnalyzer on iOS; sherpa-onnx or Moonshine on Android), passing text events to JavaScript. The React Native wrapper for FluidAudio shows the bridging pattern but no Capacitor plugin was found.
- WASM-only (no WebGPU) is realistic for Moonshine tiny/small or streaming Zipformer class models, not for 0.6B models, given Moonshine's native CPU latencies and the usual WASM penalty.

### Gaps
- No benchmark found of any ASR model inside iOS WKWebView or Android System WebView (as opposed to desktop Chrome).
- No hardware-identified WebGPU RTF for Parakeet/Moonshine/Whisper; all figures above are self-reported demos.
- No numbers found for sherpa-onnx WASM streaming performance.
- WebNN availability (which could reach NPUs from a web view on Copilot+ PCs) for ASR: no data found.

## 3. Speaker diarisation and identification on-device (and excluding the device's own voice)

### Takeaway
Real-time diarisation on-device is computationally cheap (tens to hundreds of times real time) but accuracy drops sharply versus offline: about 10–20% DER offline on AMI versus about 21–55% streaming, depending on the method. Recognising a small set of enrolled voices via speaker embeddings (WeSpeaker, CAM++, TitaNet) is a much easier problem than open diarisation and is the practical route to "who spoke"; excluding the device's own synthesised speech is best done with echo cancellation using the known TTS signal plus text matching.

### Cited Findings

**Accuracy and speed (FluidAudio Core ML, Apple silicon, AMI single distant microphone unless noted)**
- [P] Offline pipeline (pyannote community-1 segmentation + embeddings + VBx clustering): 10.6% DER, 17.4% JER at 323x RTFx on M5 Pro (16-meeting average, re-run 2026-07-03). With 2026-10-30 defaults: 9.4% DER with overlap, correct speaker count in 15 of 16 meetings. Under the stricter pyannote protocol the same pipeline scores 18.3–24.2% versus pyannote community-1's published 17.0%. — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md)
- [P] Streaming pyannote + WeSpeaker pipeline: 5 s chunks 39.0% DER (speaker error 29.4%) at 99x; 10 s chunks 38.2% at 208x; 3 s chunks with 1 s overlap 53.3% DER (speaker error 46.2%). Most of the error is speaker confusion, not missed speech. — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md)
- [P] NVIDIA streaming Sortformer (Core ML): 31.7% DER on AMI with NVIDIA's high-latency config (30.4 s chunks) on M2 at 127x; a newer "highContextV2_1" streaming config gives 26.4% DER (miss 23.4, false alarm 0.6, confusion 2.4) at 835x. Fixed maximum of 4 speakers. — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md); [FluidInference/FluidAudio](https://github.com/FluidInference/FluidAudio)
- [P] LS-EEND (streaming end-to-end, up to 10 speakers), CPU only on M4 Max, 500 ms step: 20.7% DER (miss 12.1, false alarm 2.7, speaker error 5.9) at 74.5x. This is the best streaming DER in the FluidAudio tables. — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md)
- [P] CAM++ speaker embedding (Core ML, M5 Pro): 0.48% equal error rate on AISHELL-1; mean cosine similarity 0.805 same-speaker versus 0.256 different-speaker. — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md)
- [P] VoxConverse (FluidAudio offline): 13.9–15.1% average DER, 10.5–10.7% median, 65–122x RTFx. — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md)
- [S] pyannote publishes community-1 at 17.0% DER on AMI IHM and 19.9% on AMI SDM. — [pyannote benchmark page](https://www.pyannote.ai/benchmark)
- [S] A third-party benchmark over 132 recordings in eight languages found streaming and offline Sortformer within 0.5 DER points of each other on several languages, and pyannote community-1 with the best speaker-count agreement (Spanish 91.7%, English 77.1%) but the worst DER on both — contradicting FluidAudio's guidance that offline pyannote is most accurate. — [Soniqo diarisation benchmarks](https://soniqo.audio/benchmarks/diarization)

**Enrolment / speaker identification**
- [P] FluidAudio describes its WeSpeaker/pyannote streaming pipeline as supporting "reliable speaker pre-enrollment" and speaker database management; embedding extraction is exposed. — [FluidInference/FluidAudio](https://github.com/FluidInference/FluidAudio)
- [P] sherpa-onnx provides speaker diarisation, speaker identification and speaker verification on every platform it supports (Android, iOS, Windows, macOS, Linux, WebAssembly). — [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
- [S] sherpa-onnx diarisation pairs pyannote segmentation-3.0 with an embedding extractor chosen from 3D-Speaker (incl. CAM++), NeMo (TitaNet small/large) or WeSpeaker, plus fast clustering. — [sherpa-onnx diarisation demo source](https://huggingface.co/spaces/k2-fsa/speaker-diarization/blob/main/model.py); [LocalAI diarisation docs](https://localai.io/features/audio-diarization/index.html)
- [P] Moonshine's library attaches an experimental speaker ID and speaker index to each transcript line by default; the README warns accuracy "may not suit every application". — [moonshine README (fork copy)](https://github.com/thinhlpg/moonshine)

**Licences**
- [S] pyannote.audio code MIT; community-1 pipeline weights CC-BY-4.0 and gated on Hugging Face (terms must be accepted to download). — [pyannote blog](https://www.pyannote.ai/blog/top-7-speaker-diarization-apis-and-models-in-2026); [community-1 Core ML port card](https://huggingface.co/aufklarer/Pyannote-Community-1-CoreML)
- [S] pyannote segmentation-3.0 MIT; WeSpeaker toolkit and ResNet34 model Apache-2.0; VoxCeleb-derived CAM++ weights CC-BY-4.0; Rev reverb-diarization v1/v2 non-commercial only. — [42ailab model packaging page](https://huggingface.co/42ailab/Speaker-Diarization-Models)
- [P] NVIDIA Sortformer weights: NVIDIA Open Model License (per FluidAudio README); the Core ML conversion card is tagged CC-BY-4.0 by one re-uploader [S] — conflict, verify. — [FluidInference/FluidAudio](https://github.com/FluidInference/FluidAudio); [re-upload README](https://huggingface.co/aoiandroid/diar-streaming-sortformer-coreml/blob/main/README.md)
- [S] Open-source SpeakerKit (Argmax, MIT SDK) uses pyannote; SpeakerKit Pro is a paid licence and diarised a 6:22 file in ~2 s on an iPhone (March 2025, older). — [Argmax SpeakerKit blog](https://www.argmaxinc.com/blog/speakerkit)
- [S] pyannote's own streaming product ("Live-1") is a separate commercial offering; community-1 examples are offline, file-based. — [pyannote blog](https://www.pyannote.ai/blog/top-7-speaker-diarization-apis-and-models-in-2026)

**Excluding the device's own synthesised speech**
- [S] Chromium's AEC3 echo canceller is on by default for `getUserMedia` unless disabled; constraints are requests, so check the applied value with `getSettings()`. — [GetStream echo cancellation explainer](https://getstream.io/blog/what-is-echo-cancellation/)
- [S] Recommended layering for voice agents: browser/OS AEC on the mic track, plus comparing STT output against the text the system just spoke, plus reference-signal cancellation (SpeexDSP or WebRTC AEC3) using the known TTS audio. Double-talk (both speaking) is the hardest case and aggressive AEC can suppress the human talker. — [Deepgram audio preprocessing and barge-in guide](https://developers.deepgram.com/guides/deep-dives/audio-preprocessing-barge-in); [Coval echo cancellation](https://www.coval.dev/blog/voice-ai-echo-cancellation)
- [P] FluidAudio ships LocalVQE (Apache-2.0, 1.3M–4.8M params, beta): neural echo cancellation + noise suppression + dereverberation with 16 ms streaming latency, 14–36x real time on CPU; on an AEC-Challenge synthetic subset near-end word recall rose from 44.1% to 77.6% and far-end leakage fell from 34.0% to 1.1% (labelled exploratory). — [FluidInference/FluidAudio](https://github.com/FluidInference/FluidAudio)
- [P] sherpa-onnx includes speech enhancement (gtcrn, DPDFNet) and source separation. — [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)

### Inferences
- For this app the tractable formulation is closed-set identification, not blind diarisation: VAD-segment each utterance, compute one embedding (CAM++/WeSpeaker/TitaNet, a few MB to tens of MB), compare by cosine similarity to enrolled family/carer profiles, and label everything below threshold "unknown speaker N". The CAM++ same/different similarity gap (0.805 vs 0.256) suggests this is reliable on clean segments of a few seconds; short backchannels ("yeah", "ok") and overlapped speech will be the failure cases.
- The AAC user's own voice output is synthesised and known in advance, which gives three independent rejection signals: (1) AEC with the TTS reference, (2) gating/flagging ASR output while TTS is playing, (3) an enrolled embedding of the TTS voice plus fuzzy text match against what was just spoken. This is stronger than what generic voice agents have.
- Streaming end-to-end diarisers (LS-EEND at ~21% DER, Sortformer v2.1 at ~26%) are now better than chunked clustering (39–55%) for live use; combining one of them for turn boundaries/overlap with embedding matching for identity is the likely best design. Sortformer's 4-speaker cap fits most household conversations.
- All diarisation/embedding components are tiny relative to ASR, so the compute budget is not the constraint on any of the four device classes; accuracy on far-field overlapped speech is.
- Only FluidAudio offers the whole stack (ASR + streaming diarisation + enrolment + AEC) on Apple platforms; sherpa-onnx is the only single dependency covering Windows, Android, iOS, macOS and WASM with diarisation and speaker ID.

### Gaps
- No published accuracy for enrolled-speaker identification in far-field household conditions (identification error rate with 3–6 enrolled voices) was found; the CAM++ EER is on read Mandarin speech.
- No verified source on whether sherpa-onnx offers streaming (online) diarisation or Sortformer support as of Nov 2026.
- No source found on Apple-provided speaker identification/diarisation APIs for third-party apps; a single blog says SpeechAnalyzer has none.
- Target-speaker ASR / speaker-attributed ASR models runnable on-device (e.g. joint ASR+diarisation such as Sortformer-conditioned Parakeet/Canary, or Moonshine's built-in speaker ID) — no accuracy figures retrieved.
- No data on diarisation speed/accuracy measured on Android tablets or Windows CPUs; all DER/RTFx numbers above are Apple silicon.
- The Soniqo and FluidAudio docs pages could not be opened, so the conflict between them is reported from search extracts only.

## 4. Robustness: far-field, noise, overlap, atypical speech, VAD, turn-end detection, always-listening cost

### Takeaway
VAD and turn detection are solved cheaply (Silero VAD, FSMN-VAD, Pipecat Smart Turn v3 at 8 MB and ~10–65 ms on CPU, Kyutai's built-in semantic VAD, Parakeet EOU's end-of-utterance token), but accuracy on far-field, overlapped and atypical speech is the unsolved part: no public benchmark covers the app's actual acoustic conditions, and WER on dysarthric speech exceeds 50% for all systems at severe levels.

### Cited Findings

**VAD**
- [P] Silero VAD v6.2.1 (Core ML, M1 Air): 94.0% accuracy / 100% recall on a 50-clip set at ~1,078x real time; on VOiCES (far-field reverberant) subset 96.0% accuracy; on full MUSAN (noise/music) 94.2% accuracy but recall 78.9% at threshold 0.8. — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md)
- [P] FSMN-VAD versus an older Silero baseline: 98.0% vs 82.0% accuracy on the 50-clip set; on MUSAN noise FSMN-VAD false-positive rate 18.1% versus Silero 30.2%. — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md)
- [P] Moonshine's library has an integrated VAD segmenter with tunables (threshold 0.5, 0.5 s window, 15 s maximum segment). — [moonshine README (fork copy)](https://github.com/thinhlpg/moonshine)

**Turn-end detection**
- [P] Pipecat Smart Turn v3.2: audio-only end-of-turn classifier, Whisper-tiny encoder + linear head, ~8M params, 8 MB int8 CPU build (32 MB fp32), 23 languages, takes up to 8 s of 16 kHz mono audio; "as little as 10 ms on some CPUs", ~65 ms on a standard cloud instance. Code, weights, datasets and training script BSD-2-Clause. — [pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn)
- [S] Daily's launch post claims 12 ms CPU inference for v3; Pipecat recommends pairing it with a 0.2 s VAD stop threshold. — [Daily blog](https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/); [Pipecat docs](https://docs.pipecat.ai/server/utilities/smart-turn)
- [S] An independent evaluation cited in a conference talk gives Smart Turn v3 58.9% recall / 68.4% precision on its test set, versus 87.7% recall / 57.2% precision for a hierarchical end-of-turn method — i.e. far from solved. — [AI Engineer talk page](https://www.ai.engineer/talks/hMlLw1LeIK8-designing-voice-agents-real-conversations)
- [S] LiveKit turn detector: text-based (operates on the ASR transcript), distilled from Qwen2.5-0.5B-Instruct, multilingual (13 languages), ~400–500 MB RAM, ~25 ms per inference on CPU; plugin code Apache-2.0 but the model is under the custom "LiveKit Model License". — [LiveKit plugin docs](https://docs.livekit.io/reference/python/livekit/plugins/turn_detector/multilingual.html); [LiveKit blog](https://livekit.com/blog/improved-end-of-turn-model-cuts-voice-ai-interruptions-39); [PyPI](https://pypi.org/project/livekit-plugins-turn-detector/1.5.0/)
- [P] Kyutai stt-1b-en_fr includes a semantic VAD head predicting end of turn; Parakeet EOU emits an end-of-utterance token as part of streaming decoding. — [kyutai-labs/delayed-streams-modeling](https://github.com/kyutai-labs/delayed-streams-modeling); [FluidInference/FluidAudio](https://github.com/FluidInference/FluidAudio)

**Far-field, long-form, overlap**
- [P] Same models, harder audio: Parakeet v3/Ultra/Phonon-2 go from 2.1–2.5% WER on LibriSpeech test-clean to 13.5–17.2% on a 60-minute recording; a CTC Parakeet 110M scores 15.0% WER on Earnings-22. — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md)
- [P] On far-field AMI SDM, streaming diarisers miss 12–23% of speech (LS-EEND 12.1%, Sortformer 23.4%), mostly overlapped/quiet speech. — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md)
- [S] Nemotron streaming averages 8.0–8.2% WER across eight benchmarks (includes AMI-type sets) even though it is ~2.6% on LibriSpeech. — [arXiv 2604.14493](https://arxiv.org/html/2604.14493v2)

**Atypical speech (relevant if carers or family members, or the user's residual speech, are atypical)**
- [S] IJIS 2026 benchmark on TORGO: leading systems (incl. Whisper large-v3) reach ~1–2% WER on mild dysarthria but every system exceeds 51% WER on severe dysarthria. — [Strathprints record](https://strathprints.strath.ac.uk/96698/)
- [S] June 2026 Dutch study: off-the-shelf ASR and human listeners both exceed 70% WER on dysarthric speech on average; personalised fine-tuned models still above 23%. — [arXiv 2606.30237](https://arxiv.org/abs/2606.30237)
- [S] A 2026 single-speaker case study reached 9.7% / 7.8% WER with a personalised fine-tuned Whisper pipeline. — [arXiv 2606.31722](https://arxiv.org/pdf/2606.31722)

**Always-listening cost**
- [P] Proxy figures only: VAD runs at >1,000x real time; streaming ASR at 20–90x real time on Apple silicon (so roughly 1–5% duty on one accelerator while speech is present); Moonshine reports "compute cost" as processing time as a percentage of audio duration. — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md); [moonshine README (fork copy)](https://github.com/thinhlpg/moonshine)

### Inferences
- A VAD-gated cascade (VAD always on → streaming ASR only during speech → turn detector at pauses) keeps average compute low; the costly component for battery/thermals will be the reply-prediction LLM triggered at each turn end, not ASR.
- For this app the turn-end signal has a different purpose than in voice agents: it decides when to (re)run reply prediction. Running predictions on partial transcripts and refreshing at turn end makes turn-detector errors cheap, so the 8 MB audio-only Smart Turn (BSD-2) or the ASR's own EOU token is sufficient; the 400 MB LiveKit model with a custom licence is not worth it.
- Tablet far-field capture will likely dominate error; an external/array microphone or the OS voice-processing audio mode (beamforming + AEC) may give more WER improvement than swapping ASR models. This is an inference; no source quantified it.

### Gaps
- No measured battery drain or thermal data for always-on VAD + streaming ASR on an iPad or Android tablet was found.
- No benchmark of open on-device models on far-field household conversation (CHiME-style) in 2026 was retrieved; no accented-English breakdown either.
- No data on Parakeet/Moonshine/Nemotron with atypical speech; dysarthria results are for Whisper and commercial APIs, on close-talk read speech.
- Silero VAD's latest version/licence (historically MIT) not re-verified from a primary source in this session.

## 5. Custom engineering beyond off-the-shelf

### Takeaway
The highest-value additions are contextual biasing with the user's vocabulary and contact names (available today for transducer models in sherpa-onnx, and via a CTC keyword spotter in FluidAudio, though not yet for its streaming path), per-household speaker enrolment, and a transcript-correction pass by the on-device LLM that already has to run; per-user fine-tuning and distillation are proven in the literature but have less ready-made tooling.

### Cited Findings
- [S] sherpa-onnx hotwords (contextual biasing): implemented with an Aho-Corasick automaton at decode time, no retraining; per-phrase boost weights; works for streaming and non-streaming models but only for transducer / NeMo-transducer model types and switches decoding to modified beam search. — [sherpa-onnx hotwords docs](https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html); [docs source](https://github.com/k2-fsa/sherpa/blob/master/docs/source/onnx/hotwords/index.rst)
- [S] FluidAudio custom vocabulary: adds a CTC keyword-spotting encoder (Parakeet 110M, ~60 MB extra) alongside TDT; batch mode only, not supported with streaming Parakeet EOU; throughput drops from 156x to 63x. — [FluidAudio custom vocabulary docs](https://docs.fluidinference.com/asr/custom-vocabulary.md)
- [P] FluidAudio CTC keyword boosting on Earnings-22: vocabulary precision 99.3%, recall 85.2%, F-score 91.7% at 63x RTFx. — [FluidAudio Benchmarks.md](https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/Benchmarks.md)
- [S] NVIDIA NeMo: Parakeet TDT did not support flashlight word boosting; NVIDIA staff said phrase boosting via shallow fusion for RNNT/TDT was in progress (status of release not confirmed). — [Hugging Face discussion](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2/discussions/34)
- [P] Kyutai STT supports experimental text and audio prompting to steer spelling and adapt to a speaker. — [kyutai-labs/delayed-streams-modeling](https://github.com/kyutai-labs/delayed-streams-modeling)
- [S] Personal fine-tuning works: fine-tuned Whisper reached 7.8–9.7% WER for one dysarthric speaker; personalised models roughly cut WER from >70% to >23% in a Dutch study; Whisper and Qwen3-ASR adaptation has been studied on conversational aphasic speech. — [arXiv 2606.31722](https://arxiv.org/pdf/2606.31722); [arXiv 2606.30237](https://arxiv.org/abs/2606.30237); [arXiv 2603.15261](https://arxiv.org/pdf/2603.15261)
- [S] Quantisation is nearly free: Nemotron int4 costs 0.17 WER points for a 3.7x size reduction; int8 Parakeet shows no measured loss in one project's tests. — [arXiv 2604.14493](https://arxiv.org/html/2604.14493v2); [parakeet int8 project](https://github.com/groxaxo/parakeet-tdt-0.6b-v3-fastapi-openai)
- [P] Smart Turn publishes its datasets and training script (BSD-2), so the turn detector can be retrained on household/AAC-paced conversation. — [pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn)
- [S] LiveKit distilled its turn detector from a 0.5B LLM to run in ~25 ms on CPU — an existence proof for distilling a text-side conversational model to edge size. — [LiveKit blog](https://livekit.com/blog/improved-end-of-turn-model-cuts-voice-ai-interruptions-39)
- [S] Voice-agent practice of comparing STT output with the text the agent just spoke to drop self-echo. — [Deepgram guide](https://developers.deepgram.com/guides/deep-dives/audio-preprocessing-barge-in)

### Inferences
- Because the transcript feeds an LLM, perfect verbatim text is unnecessary; passing the ASR n-best/partial hypotheses plus speaker label and a list of household names into the reply-prediction prompt lets the LLM absorb recognition errors without a separate correction model. No retrieved source evaluates this on-device; it is a design inference.
- A transducer model (streaming Zipformer, Nemotron/Parakeet transducer export) in sherpa-onnx is the only verified combination giving streaming + hotword biasing on all four platforms.
- Household adaptation can be staged: (1) hotword list from contacts and the AAC user's phrase history, zero training; (2) speaker enrolment embeddings, seconds of audio; (3) optional LoRA/adapter fine-tuning of the ASR on opted-in household recordings, done off-device or overnight on a Mac. Stage 3 requires consented recorded data, which interacts with section 6.
- Distilling a large offline model (Granite/Qwen3-ASR/Canary) into a small streaming student is how Moonshine and Nemotron-class models are effectively produced, but no turnkey open recipe was found; this is a research-scale effort rather than app engineering.

### Gaps
- No source found evaluating LLM-based ASR error correction running on-device, or its latency cost.
- No evidence found for hotword biasing with Moonshine or with Apple SpeechAnalyzer (the older SFSpeechRecognizer had custom vocabulary; status for SpeechAnalyzer not verified).
- No published recipe or results for few-shot per-household fine-tuning of Parakeet/Moonshine on-device.

## 6. Privacy / legal notes on continuously recording bystanders (brief)

### Takeaway
On-device processing reduces but does not remove legal exposure: in the US the question is consent to recording/interception, which varies by state, and an always-listening app that keeps transcripts of other people needs clear notice and ideally no retained audio.

### Cited Findings
- [S] US federal law requires one party's consent; states may be stricter. Roughly 11–15 states (sources differ) require all-party consent, including California, Florida, Illinois, Maryland, Montana, New Hampshire, Pennsylvania and Washington. — [Kilpatrick Townsend wiretap law overview (2024, older)](https://ktslaw.com/en/Insights/Alert/2024/7/Wiretap-Laws-in-the-United-States); [RCFP guide](https://www.rcfp.org/?p=65388)
- [S] Some states split by context: Connecticut and Nevada require all-party consent for phone calls but one-party for in-person conversations; Hawaii and Maine require all-party consent in particularly private places. — [Kilpatrick Townsend chart](https://ktslaw.com/-/media/2024/kilpatrick-wiretap-laws-chart-july-2024.pdf)
- [S] The one-party rule covers a participant recording their own conversation; if the recorder is not a party, at least one party must know and consent. — [UpCounsel overview](https://upcounsel.com/audio-surveillance-laws-by-state)

### Inferences
- The AAC user is a participant in the conversations being transcribed, which fits one-party-consent rules, but all-party states and overheard conversations the user is not part of (e.g. carers talking in the next room) are the risk cases. Mitigations that follow from the technical findings: transcribe only when the VAD/turn logic indicates a conversation directed at the user, keep audio in RAM only, store text transiently, show a visible "listening" indicator, and store speaker embeddings (biometric identifiers under laws such as Illinois BIPA and GDPR) only with explicit enrolment consent. These are design inferences, not legal advice.

### Gaps
- No source retrieved on GDPR (household exemption, biometric data for voice embeddings) or on how wiretap laws treat transient on-device transcription with no stored audio; needs proper legal review.
- State counts differ between sources (11, 12, 15) and the main chart is from July 2024.
