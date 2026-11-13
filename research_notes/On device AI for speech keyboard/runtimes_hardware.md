# On-device ML inference runtimes and hardware limits (macOS, Windows, iPadOS/iOS, Android) — state as of November 2026

Research-environment caveats (read first):
- Hosts that could NOT be fetched from this session (DNS-blocked): developers.google.com, developers.googleblog.com, capacitorjs.com, www.electronjs.org, arxiv.org. Claims that cite those hosts come from search-result extracts, not from a full read of the page, and are tagged **[extract only]**.
- Fetched and read directly: github.com repos (LiteRT-LM, sherpa-onnx, node-llama-cpp, llama.rn, web-llm, llama.cpp OpenCL doc), developer.android.com (Play for On-device AI), developer.apple.com forum thread 833642. These are tagged **[read]**.
- Anything tagged **[unverified]** is from a secondary blog/aggregator with unclear methodology. Anything tagged **[background]** is the researcher's prior knowledge (cut-off mid-2026) with a pointer URL that was not re-fetched this session.

---

## 1. In-web-view inference (WebGPU, WebNN, WASM, memory ceilings, storage, JS libraries, browser tokens/sec)

### Takeaway
By late 2026 WebGPU is on by default in Chromium/Electron on desktop, in Chrome for Android (Android 12+, Adreno/Mali, later Imagination) and in WebKit on iOS/iPadOS/macOS 26, but the mobile web views remain a poor place for anything beyond roughly 100–300 MB of model: WebKit's WebContent process has a low, undocumented memory ceiling (about 300 MB "reliably" for WASM per a WebKit bug), small LLMs via WebLLM have been reported to crash-reload on phones, WebNN is still not shipped (origin trial was switched off in March 2026 and Android was excluded), and no reliable published tokens-per-second exist for 1B+ models inside WKWebView or Android WebView. In-web-view inference is a good fit for Electron desktop and for tiny models (VAD, n-gram, sub-100M embedding/ASR) everywhere; on mobile, 0.3B+ LMs should go through a native plugin.

### Cited Findings

WebGPU status
- WebGPU is declared supported in all major browsers: Chrome/Edge (desktop since 113), Firefox, and Safari 26 on macOS Tahoe 26, iOS 26, iPadOS 26 and visionOS 26 — [web.dev](https://web.dev/blog/webgpu-supported-major-browsers?hl=en)
- gpuweb's implementation-status wiki says that in macOS Tahoe 26 / iOS 26 / iPadOS 26 / visionOS 26 WebGPU is "supported and enabled by default"; for Android it lists Imagination GPUs from Chrome 139 on Android 16+, with Samsung Xclipse still in progress — [gpuweb wiki](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)
- Chrome 121 enabled WebGPU by default on Android 12+ devices with Qualcomm and ARM GPUs only; wider rollout was "dependent on further testing" — [Chrome for Developers](https://developer.chrome.com/blog/new-in-webgpu-121); [blink-dev Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/YFWuDlCKTP4)
- WKWebView: an Apple forum reply (Dec 2024, pre-iOS 26) states Safari feature flags apply only to Safari and that "for WKWebView, the feature will work when it's enabled by default" — which it is from OS 26. So Capacitor on iOS/iPadOS 26+ should have `navigator.gpu`; on iOS 18 and earlier it does not — [Apple Developer Forums](https://developer.apple.com/forums/thread/770862)
- Early Safari 26 WebGPU had bugs: one WebKit bug reproduced through Safari 26.2 and was confirmed fixed in 26.4 — [WebKit Bugzilla 301627](https://bugs.webkit.org/show_bug.cgi?id=301627)
- WebGPU "Compatibility mode" (a subset that can run on OpenGL ES 3.1 for older Android devices) had an Intent to Ship in January 2026 with Android WebView listed for milestone 146; Chrome 146 release notes list Android compatibility mode — [blink-dev](https://groups.google.com/a/chromium.org/g/blink-dev/c/N3RlLGCOTJ4); [Chrome for Developers, WebGPU 146](https://developer.chrome.com/blog/new-in-webgpu-146)
- Real-device report (single developer, 2026): WebGPU feature detection returned true (`webgpu: true`, Apple adapter, f16) on an iPhone 11 Pro Max in Safari 26.5, but Llama-3.2-1B via WebLLM reloaded the page mid-generation; on a Pixel 8a inside the LINE in-app browser (Android 16) the run never completed. Same developer on an AMD RDNA4 desktop in Chrome 148 with WebLLM 0.2.84: ~196 decode tok/s for Llama-3.2-1B with a short prompt, but a ~1,200-token prompt gave ~77 s time-to-first-token — [HN mirror: "WebGPU feature detection was not enough to run small LLMs on phones"](https://hackernews-dynamic.seasondane.workers.dev/news/48624985) **[unverified, single source]**
- A 2026 blog claims Safari's Metal backend imposes per-buffer limits from 256 MB on older iPhones to 993 MB on iPad Pro (would force weight sharding) — [tianpan.co](https://tianpan.co/blog/2026/04/17/browser-native-llm-inference-webgpu) **[unverified; attribution between this and a sibling blog not pinned]**

WebNN
- WebNN entered a Chrome origin trial in M-146 (beta 11 Feb 2026, stable 10 Mar 2026) — [blink-dev Intent to Experiment](https://groups.google.com/a/chromium.org/g/blink-dev/c/5CWKSChYo98); [Phoronix](https://phoronix.com/news/chrome-146-beta)
- Android was excluded from the trial because only CPU inference is supported there (GPU/NPU "planned but incomplete") — [blink-dev archive](https://mid.mail-archive.com/blink-dev@chromium.org/msg15857.html)
- After M-146 shipped, the trial was disabled again because of release-blocking issues, with no new target milestone given in the thread at that time — [blink-dev archive](https://go.mail-archive.com/blink-dev@chromium.org/msg15933.html)
- Google's own statement: WebNN "can currently execute models on CPU across all platforms but support for GPU and NPU execution is more limited" — [blink-dev Intent to Experiment](https://groups.google.com/a/chromium.org/g/blink-dev/c/5CWKSChYo98)
- Edge's WebNN origin trial page is marked closed — [Microsoft Edge origin trials](https://developer.microsoft.com/microsoft-edge/origin-trials/trials/19857284-cf52-484b-8b09-8ca50ac9dccb)

WASM limits
- wasm32 linear memory tops out at 4 GB (the maximum with 32-bit pointers) — [v8.dev](https://v8.dev/blog/4gb-wasm-memory)
- memory64 lifts that but has a performance cost; Mozilla's SpiderMonkey team: "the only reason to use Memory64 is if you actually need more than 4GB" — [spidermonkey.dev](https://spidermonkey.dev/blog/2025/01/15/is-memory64-actually-worth-using.html)
- SharedArrayBuffer / WASM threads require a cross-origin-isolated document (COOP + COEP both set on the main document); hosts that cannot set headers cannot enable it — [web.dev](https://web.dev/articles/coop-coep); [web.dev why](https://web.dev/articles/why-coop-coep)
- iOS-specific WASM threading bug history: on iOS 16.4 creating a *shared* `WebAssembly.Memory` failed with out-of-memory where non-shared worked — [WebKit Bugzilla 255103](https://bugs.webkit.org/show_bug.cgi?id=255103)

Memory ceilings in mobile web views
- WebKit bug titled "Only ~300 MB of RAM is reliably available to WebAssembly pages" (iOS); Unity developers report not being able to allocate a tenth of what Android Chrome allows — [WebKit Bugzilla 269777](https://bugs.webkit.org/show_bug.cgi?id=269777)
- Apple forum answers: the WKWebView/WebContent memory limit cannot be raised and "is not a set number"; it depends on device RAM and system load. Failure mode is the web content process being killed and the page reloaded, not a catchable allocation error — [Apple Developer Forums 766309](https://developer.apple.com/forums/thread/766309); [Apple Developer Forums 771787](https://developer.apple.com/forums/thread/771787)
- transformers.js issue: memory allocation problems on Android "make it impossible to reliably deploy Transformers.js on mobile phones" (reporter's words) — [huggingface/transformers.js#1319](https://github.com/huggingface/transformers.js/issues/1319)

Libraries
- transformers.js v4: new WebGPU runtime rewritten in C++ with the ONNX Runtime team; 4.0.0 released, 4.2.0 listed on GitHub (a secondary review dates 4.2.0 to 23 April 2026). Secondary coverage cites ~4x speedup on BERT-style embedding workloads — [Hugging Face blog](https://huggingface.co/blog/transformersjs-v4); [GitHub releases](https://github.com/huggingface/transformers.js/releases). Licence Apache-2.0 **[background]** — [repo](https://github.com/huggingface/transformers.js)
- WebLLM (MLC): Apache-2.0; WebGPU required; runs in a dedicated Web Worker or Service Worker (browser may kill the service worker; engine sends keep-alive heartbeats); weight cache backends are Cache API (default), IndexedDB, OPFS (`opfsAccessMode` async/auto/sync) and an experimental cross-origin store; README shows dependency pin `^0.2.88`; no statement about mobile support **[read]** — [mlc-ai/web-llm](https://github.com/mlc-ai/web-llm)
- WebLLM paper: 4-bit 3B model decodes at 90 tok/s on an Apple M3 laptop in-browser; Llama-3.1-8B 41.1 tok/s on M3 Max; claims up to ~80% of native MLC performance (Dec 2024, older figure) — [arXiv 2412.15803](https://arxiv.org/html/2412.15803v1)
- wllama (llama.cpp WASM): v3 adds WebGPU, multimodal and tool calling (earlier versions were CPU-only); single-file limit is still 2 GB because of ArrayBuffer size, larger GGUFs must be split with `llama-gguf-split` and are downloaded in parallel (default 3) — [ngxson/wllama](https://github.com/ngxson/wllama); [README 3.8.1](https://cdn.jsdelivr.net/npm/@wllama/wllama@3.8.1/README.md). Licence MIT **[background]**
- A llama.cpp PR notes WebGPU + OPFS could allow >2 GB models without shards (not confirmed shipped in wllama) — [ggml-org/llama.cpp#22497](https://github.com/ggml-org/llama.cpp/pull/22497)
- LiteRT-LM has a JavaScript (web) API in "Early Preview"; Web SDK defaults to the GPU backend **[read]** — [google-ai-edge/LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM). Google's LiteRT-LM blog chart includes a web (WebGPU) data point measured on a MacBook Pro M4 Max **[extract only]** — [Google Developers Blog](https://developers.googleblog.com/en/blazing-fast-on-device-genai-with-litert-lm/)
- sherpa-onnx ships WebAssembly and NodeJS targets in addition to native ones (ASR streaming/non-streaming, TTS, VAD, KWS, speaker ID/diarisation, punctuation, speech enhancement) **[read]** — [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
- A commercial comparison of cross-browser WASM LLM inference (vendor source) exists and argues WASM-CPU is the only path that works across all browsers — [Picovoice blog](https://picovoice.ai/blog/cross-browser-local-llm-inference-using-webassembly/) **[vendor source]**

Published in-browser tokens/sec (all desktop; nothing reliable for phones/tablets)
- M3 laptop, 3B 4-bit, WebLLM: 90 tok/s — [arXiv 2412.15803](https://arxiv.org/html/2412.15803v1)
- AMD RDNA4 desktop GPU, Chrome 148, Llama-3.2-1B, WebLLM 0.2.84: ~196 tok/s decode (short prompt) — [HN mirror](https://hackernews-dynamic.seasondane.workers.dev/news/48624985) **[unverified]**

### Inferences
- For Electron (bundled Chromium, desktop GPU drivers, no WebContent jetsam), in-renderer or utility-process WebGPU via transformers.js v4 / ONNX Runtime Web / WebLLM is viable for embeddings, small ASR, small TTS and LMs up to roughly 1–3B, with native sidecars only needed for the upper tier or for CPU-only machines.
- For Capacitor on iOS/iPadOS, the WKWebView content process is a separate, memory-capped process that does not inherit the host app's increased-memory entitlement (see Gaps), so the same model that fits natively will crash-reload in the web view. Budget: tens of MB to ~300 MB total (weights + runtime) inside WKWebView.
- For Capacitor on Android, WebView WebGPU availability depends on WebView version (Chromium ≥121, compat mode ≥146), Android version (12+) and GPU vendor; `navigator.gpu` must be feature-probed and actually exercised (load + run a tiny model), since the HN report shows detection alone is insufficient.
- WebNN cannot be planned on for 2026–early 2027 shipping: not in stable Chromium, Android excluded, not in WebKit.
- WASM threads inside Electron and Capacitor need cross-origin isolation. In Electron this is achievable by serving the app from a custom protocol or local server that sets COOP/COEP; in Capacitor the scheme handler would need to add those headers (no source found confirming this works on `capacitor://` in WKWebView). Fallback: single-threaded WASM SIMD builds (slower by roughly the core count).
- Store weights in OPFS or the native filesystem rather than the Cache API on mobile: sharded 2 GB limits (wllama) and WebKit eviction make large Cache API payloads fragile; with a native plugin the weights should live in the app's files directory and never pass through the web view.

### Gaps
- No primary source found stating the Android System WebView version in which full (non-compat) WebGPU became default-on; only Chrome-for-Android statements and the compat-mode milestone.
- No published tokens/sec for 0.3–4B models in WKWebView or Android WebView on phones/tablets. The only mobile evidence found is failure reports.
- Could not verify whether COOP/COEP headers are honoured for Capacitor's `capacitor://localhost` (iOS) and `https://localhost` (Android) schemes, or the exact Electron recipe (electronjs.org blocked).
- Shader/pipeline compilation cold-start times: the only number found is the ~77 s TTFT for a 1,200-token prompt on a desktop GPU (which conflates prefill and compilation). No systematic cold-start data.
- transformers.js v4 memory64 use / >4 GB support not confirmed from release notes.
- Ratchet, Burn and candle WASM: no 2026 status found in this session; not evaluated. "Llamas on the Web" (arXiv 2605.20706, 2026) appears relevant to memory-efficient browser LLMs but arxiv.org was blocked — [alphaxiv listing](https://www.alphaxiv.org/abs/2605.20706.md).
- Cache API / OPFS quota numbers per platform were not retrieved.

---

## 2. Native inference options and bridging them to a web UI

### Takeaway
The only stack a small team can realistically ship on all four platforms with one model format is llama.cpp (GGUF) for language models plus sherpa-onnx (ONNX) for ASR/TTS/VAD: both are permissively licensed (MIT / Apache-2.0), have Electron bindings (node-llama-cpp, sherpa-onnx Node addon) and mobile bindings (llama.rn-derived Capacitor plugins, sherpa-onnx Swift/Kotlin). LiteRT-LM is the fastest cross-platform alternative for Gemma-family models on phone GPUs (about 50+ tok/s for Gemma 4 E2B on flagship GPUs) and is worth adding as a second engine on Android/iOS; MLX, Core ML, ExecuTorch-QNN, Foundry Local/Windows ML and OpenVINO are per-platform optimisations rather than a common base.

### Cited Findings

llama.cpp family
- llama.cpp OpenCL backend: verified on Adreno 750 (Snapdragon 8 Gen 3), 810 (7s Gen 3), 830 (8 Elite), 840 (8 Elite Gen 5), X1-85 (Snapdragon X Elite) and X2-90 (X2 Elite); "A6x GPUs in phones are likely not supported due to the outdated driver and compiler"; Mali is not mentioned; supported quantisations now include Q4_0, Q4_1, Q5_0/1, Q8_0, Q4_K, Q5_K, Q6_K, IQ4_NL; builds documented for Android (NDK 26, android-28) and Windows 11 Arm64 (Clang 19) **[read]** — [llama.cpp docs/backend/OPENCL.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/OPENCL.md)
- llama.cpp documents three Snapdragon backends: CPU, Adreno GPU (OpenCL) and Hexagon NPU — [mirror of docs/backend/snapdragon/README.md](https://git.mitjafelicijan.com/r/llmnpc/blob/llama.cpp/docs/backend/snapdragon/README.md)
- Qualcomm says it significantly improved OpenCL backend decode speed and TTFT on Adreno, and in April 2026 published CPU acceleration work (QMX) for llama models (vendor claims; numbers not extracted) — [Qualcomm blog 2025](https://www.qualcomm.com/developer/blog/2025/02/harnessing-qualcomm-adreno-gpu-generative-ai-open-source-approach); [Qualcomm blog 2026](https://www.qualcomm.com/developer/blog/2026/04/llama-models-acceleration-on-cpu-qmx)
- An academic study of LLMs on commodity phones found that higher-spec GPUs do not necessarily perform better (e.g. Mali-G720 Immortalis MP12 vs Adreno 750), i.e. software/driver support dominates — [arXiv 2410.03613](https://arxiv.org/html/2410.03613v3)
- node-llama-cpp: MIT; prebuilt binaries for macOS, Linux and Windows with Metal, CUDA and Vulkan backends chosen automatically; falls back to building from source with cmake if no prebuilt matches (can be disabled with `NODE_LLAMA_CPP_SKIP_DOWNLOAD`); JSON-schema-constrained output, function calling, embeddings and reranking **[read]** — [withcatai/node-llama-cpp](https://github.com/withcatai/node-llama-cpp)
- `@electron/llm`: Electron-org package exposing an API shaped like Chromium's built-in AI API but running any GGUF via node-llama-cpp — [electron/llm](https://github.com/electron/llm)
- llama.rn: MIT; React Native (New Architecture required from v0.10) binding for iOS and Android (arm64-v8a, x86_64 only); iOS Metal on by default (not in simulator); Android OpenCL targets Adreno 700+ and README states support limited to Q4_0 and Q6_K; experimental Hexagon NPU (HTP) on Snapdragon 8 Gen 1+; README recommends enabling Extended Virtual Addressing and Increased Memory Limit on iOS; features include mmproj multimodal, experimental on-device TTS with voice cloning, embeddings/rerank, parallel slots, speculative decoding (MTP/draft), GBNF/JSON-schema sampling **[read]** — [mybigday/llama.rn](https://github.com/mybigday/llama.rn)
- Capacitor bindings of llama.cpp exist: `llama-cpp-capacitor` (MIT, iOS arm64/x86_64 with Metal, Android arm64-v8a/armeabi-v7a/x86/x86_64, API modelled on llama.rn, version 0.1.x) and `@cantoo/capacitor-llama` (very low usage, ~63 weekly downloads) — [arusatech/llama-cpp](https://github.com/arusatech/llama-cpp); [socket.dev listing](https://socket.dev/npm/package/@cantoo/capacitor-llama)

Google AI Edge
- LiteRT-LM: Apache-2.0; v0.19.0; Android, iOS, Web, desktop (Linux/macOS/Windows), Raspberry Pi; APIs: Kotlin, Python, C++ stable; Swift and JavaScript "Early Preview"; Flutter community; models named include Gemma 4 E4B (with MTP drafters), Gemma 3n E2B, plus speech models Qwen3-ASR, Kokoro, Qwen3-TTS; "GPU and NPU accelerators" **[read]** — [google-ai-edge/LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM)
- LiteRT-LM benchmarks (Gemma 4 E2B, 1024 prefill / 256 decode tokens, 2048 context): 52.1 tok/s decode on Samsung S26 Ultra GPU (OpenCL); 56.5 tok/s on iPhone 17 Pro GPU (Metal) vs 25.0 tok/s on iPhone 17 Pro CPU; 24.2 tok/s Jetson Orin Nano GPU; 31.7 tok/s on a Qualcomm Dragonwing IQ8 NPU — [HF model card litert-community/gemma-4-E2B-it-litert-lm](https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm) **[extract only]**; [Google Developers Blog](https://developers.googleblog.com/en/blazing-fast-on-device-genai-with-litert-lm/) **[extract only]**
- Multi-token prediction (MTP) drafters give "up to 2.2x" decode speedup on S26 Ultra GPU per the blog (the repo README says "up to 3x") — [Google Developers Blog](https://developers.googleblog.com/en/blazing-fast-on-device-genai-with-litert-lm/) **[extract only]**; [LiteRT-LM repo](https://github.com/google-ai-edge/LiteRT-LM)
- Independent test in the AI Edge Gallery app (Gemma 4 E2B, 256/256 tokens, 3 runs): A19 Pro GPU 51.28 tok/s vs Snapdragon 8 Elite Gen 5 GPU 48.55 tok/s; A19 Pro CPU 36.99 tok/s — [Beebom](https://gadgets.beebom.com/stories/i-tested-on-device-ai-on-android-and-iphone-results-not-even-close)
- NPU reality: Google's blog says NPU acceleration is currently Android-only; a developer write-up reports `Backend.NPU()` can cause native process crashes (SIGKILL/SIGSEGV) because of driver fragmentation — [Google Developers Blog](https://developers.googleblog.com/en/blazing-fast-on-device-genai-with-litert-lm/) **[extract only]**; [dev.to](https://dev.to/samdude/gemma-4-on-android-tricks-for-faster-on-device-inference-3kj5) **[unverified]**

Speech runtime
- sherpa-onnx: Apache-2.0; Android (arm64/arm32/x64/x86), iOS arm64, Windows (x64/x86/arm64), macOS (x64/arm64), Linux, HarmonyOS, plus WebAssembly and NodeJS; 12 language bindings including C/C++, JavaScript, Swift, Kotlin, Java, C#, Rust, Dart; NPU paths for Qualcomm QNN, Rockchip RKNN, Ascend, Axera and Intel (OpenVINO); also has Flutter and Tauri demos **[read]** — [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)

PyTorch / Meta
- ExecuTorch 1.0 (GA, Oct 2025): Vulkan GPU backend promoted to production-ready; new backends include Arm VGF, NXP eIQ Neutron, Samsung Exynos NPU/GPU and Intel OpenVINO; MediaTek NPU and Apple MPS listed separately as existing (alpha/beta) backends; Python and Maven (Android) package variants for Vulkan and QNN; LLM runner APIs extended to vision and audio — [PyTorch blog](https://pytorch.org/blog/introducing-executorch-1-0/); [Arm newsroom](https://newsroom.arm.com/?p=17938). Licence BSD-3-Clause **[background]** — [pytorch/executorch](https://github.com/pytorch/executorch)
- Older ExecuTorch XNNPACK phone numbers (2024, pre-1.0): Llama 3.2 1B ≈ 19 tok/s baseline on OnePlus 12 class devices; Llama 3 8B 4-bit ≈ 8–11 tok/s — [ExecuTorch llama example (AOSP mirror)](https://android.googlesource.com/platform/external/executorch/+/afb26644c/examples/models/llama2/README.md) **[older figure]**

Microsoft
- Foundry Local reached GA on 9 April 2026 for Windows, macOS (Apple silicon) and Linux x64; SDK is MIT-licensed, the CLI is under Microsoft Software License Terms; it can be bundled into an app (a third-party write-up describes a ~20 MB native library) — [Microsoft Foundry blog](https://devblogs.microsoft.com/foundry/foundry-local-ga/); [microsoft/foundry-local](https://github.com/microsoft/foundry-local); [lilting.ch write-up](https://lilting.ch/en/articles/microsoft-foundry-local-bundled-ai-runtime) **[size figure unverified]**
- Foundry Local on Windows registers execution providers via Windows ML (CUDA, WebGPU, AMD Vitis, Qualcomm NPU, OpenVINO appear in Microsoft's docs); on Apple silicon it uses the ONNX Runtime WebGPU execution provider via Dawn — [Microsoft Learn: Foundry Local architecture](https://learn.microsoft.com/en-ie/Azure/foundry-local/concepts/foundry-local-architecture) **[extract only]**
- Foundry Local Python SDK depends on `onnxruntime` and `onnxruntime-genai-core`; Windows wheels include a registration-free WinML 2.x runtime — [foundry-local-sdk package index](https://simple-repository.app.cern.ch/project/foundry-local-sdk)
- ONNX Runtime and ONNX Runtime GenAI are MIT **[background]** — [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime); [microsoft/onnxruntime-genai](https://github.com/microsoft/onnxruntime-genai)

Apple
- Apple's own Core ML guidance for LLMs ("On Device Llama 3.1 with Core ML"): Llama-3.1-8B-Instruct at ~33 tok/s decode on an M1 Max using the GPU, after moving from a no-KV-cache/static-shape baseline to stateful KV cache and Int4 block-wise quantisation — [Apple ML Research](https://machinelearning.apple.com/research/core-ml-on-device-llama)
- A developer blog reports Core ML silently falls back to GPU for state-update ops unless configured, i.e. ANE use for stateful LLMs is not automatic — [dev.to](https://dev.to/software_mvp-factory/wiring-apples-neural-engine-to-core-mls-stateful-models-24m1) **[unverified]**
- Third-party "CoreML-LLM" Swift package claims 52 tok/s on iPhone 17 Pro via ANE and 125 ms second-turn TTFT for a Qwen3-VL 2B stateful build — [brightcoding blog](https://blog.brightcoding.dev/2026/05/23/stop-wasting-gpu-cycles-coreml-llm-unlocks-ane-for-insane-on-device-speed) **[unverified]**
- MLX / mlx-lm / mlx-swift: MIT **[background]** — [ml-explore/mlx](https://github.com/ml-explore/mlx); [ml-explore/mlx-swift](https://github.com/ml-explore/mlx-swift). MLX vs llama.cpp on Apple silicon (secondary sources): Qwen2.5-14B 4-bit 68 vs 52 tok/s on M4 Pro; Qwen2.5-7B ~102 vs ~72 tok/s on M4 Max — [aiagentskit](https://aiagentskit.com/blog/mlx-vs-llama-cpp-apple-silicon/); [itsmostafa/inference-speed-tests (mirror)](https://backiee.wasmer.app/https_github_com/itsmostafa/inference-speed-tests) **[unverified]**

Third-party SDKs
- Nexa SDK: repository Apache-2.0, but NPU components need a licence key (free for personal use, one device per key; commercial NPU use requires contacting Nexa) — [NexaAI/nexa-sdk](https://github.com/NexaAI/nexa-sdk)
- Cactus: its own comparison pages call it "fully open source under the MIT license", while its later pages describe a source-available "Cactus license" (free for eligible users/qualifying organisations, otherwise commercial licence). Conflict unresolved; treat as NOT safely MIT — [cactuscompute compare page](https://cactuscompute.com/compare/best-open-source-on-device-ai); [cactuscompute engine page](https://cactuscompute.com/engine)
- Capacitor plugins for OS models: Ionic's official `@capacitor/local-llm` (Apple Foundation Models on iOS 26+, Gemini Nano via ML Kit on supported Android e.g. Pixel 9+); Capgo `@capgo/capacitor-llm` (Apple Intelligence + Gemini Nano/AICore via ML Kit GenAI Prompt API, streaming, cancellation); `capacitor-foundation-models` (iOS-only); Capawesome ML Kit 8.2.0 GenAI plugins (Android-only) — [Capacitor docs](https://capacitorjs.com/docs/apis/local-llm) **[extract only]**; [Capgo docs](https://capgo.app/docs/plugins/llm/); [npm capacitor-foundation-models](https://npmjs.com/package/capacitor-foundation-models); [Capawesome blog](https://capawesome.io/blog/capacitor-mlkit-8-2-0-release/)

Summary table (licence / coverage / practicality for a small MIT team)

| Runtime | Licence | macOS | Windows | iOS/iPadOS | Android | Bridge to web UI | Practical on all 4? |
|---|---|---|---|---|---|---|---|
| llama.cpp (GGUF) | MIT [background] | Metal | CPU, Vulkan, CUDA; OpenCL on Snapdragon X | Metal | CPU; OpenCL on Adreno 7xx+/8xx; Hexagon experimental | node-llama-cpp (Electron); llama-cpp-capacitor / custom plugin | Yes — the baseline |
| sherpa-onnx | Apache-2.0 | yes | yes (x64/arm64) | yes | yes | Node addon / WASM (Electron); Swift/Kotlin in a Capacitor plugin | Yes — speech baseline |
| LiteRT-LM | Apache-2.0 | yes | yes | Swift early preview | Kotlin stable, GPU + NPU | C++/Kotlin/Swift plugin; JS early preview | Mobile second engine; desktop optional |
| MLX / mlx-swift | MIT [background] | yes | no | yes (Metal) | no | Swift plugin or Python/Swift sidecar | Apple-only optimisation |
| Core ML | OS framework | yes | no | yes (ANE/GPU) | no | Swift plugin | Apple-only; conversion effort high |
| ExecuTorch 1.x | BSD-3 [background] | yes | partial | Core ML/MPS/XNNPACK | XNNPACK, Vulkan, QNN, MediaTek, Exynos | C++/Kotlin/Swift plugin | Possible, heavier export pipeline per backend |
| ONNX Runtime GenAI / Foundry Local | MIT (SDK) | WebGPU EP | WinML EPs incl. QNN, OpenVINO, Vitis | — | — | Node / native SDK from Electron main | Desktop only; best route to Windows NPUs |
| transformers.js / ORT Web | Apache-2.0 / MIT [background] | WebGPU | WebGPU | WKWebView (memory-capped) | WebView (device-dependent) | native to web view | Yes for tiny models |
| Nexa SDK | Apache-2.0 + keyed NPU | yes | yes | yes | yes | — | NPU licensing conflicts with MIT/open distribution |
| Cactus | disputed (MIT vs source-available) | — | — | yes | yes | — | Avoid until licence is clear |

### Inferences
- Bridging pattern: (Electron) run engines in the main process or a `utilityProcess`/sidecar via N-API addons (node-llama-cpp, sherpa-onnx-node) and stream tokens/audio over IPC/MessagePort; (Capacitor) one custom native plugin per platform wrapping llama.cpp + sherpa-onnx (and optionally LiteRT-LM / Foundation Models), streaming via plugin event listeners; audio capture and playback should also be native to avoid web-view round trips and WKWebView memory use.
- llama.rn is React-Native-specific (New Architecture), so for Capacitor the team must either adopt/fork `llama-cpp-capacitor` (young, v0.1.x, small maintainer base) or write a thin plugin directly on llama.cpp's C API/xcframework — the latter is likely the lower-risk long-term option.
- On Android mid-range devices (Snapdragon 6/7 older Adreno 6xx, Mali, Xclipse), llama.cpp GPU acceleration is effectively unavailable (OpenCL backend is Adreno-7xx/8xx-centric and explicitly excludes A6x phones), so CPU is the planning assumption; LiteRT-LM's OpenCL GPU delegate is the more plausible GPU route on Mali.
- Windows NPUs are only reachable through vendor execution providers (QNN, OpenVINO, Vitis) that Foundry Local / Windows ML abstracts; llama.cpp reaches Snapdragon X only via CPU or the Adreno OpenCL backend. A team that wants one code path on Windows should treat NPU use as an optional Foundry Local provider rather than a core dependency.

### Gaps
- Packaging size per runtime (binary MB) was not obtained from primary sources, except the unverified ~20 MB figure for Foundry Local's library.
- OpenVINO GenAI, Qualcomm AI Hub/Genie, RunAnywhere, MediaPipe LLM Inference (legacy), Ollama and LM Studio were not researched this session. [background]: Ollama (MIT) and LM Studio (proprietary) both expose a local OpenAI-compatible HTTP server and are suitable only as optional external providers on desktop; OpenVINO is Apache-2.0 — [ollama/ollama](https://github.com/ollama/ollama); [openvinotoolkit/openvino](https://github.com/openvinotoolkit/openvino).
- No clean benchmark comparing llama.cpp Vulkan on Mali vs OpenCL on Adreno was found.
- ExecuTorch 1.x per-backend LLM tokens/sec (QNN, MediaTek, Core ML) not found; its public benchmark dashboard was not accessed.
- Reports of a Core ML successor ("Core AI") announced at WWDC 2026 appeared only in secondary sources — [john-rocky/apple-silicon-llm-bench](https://github.com/john-rocky/apple-silicon-llm-bench) **[unverified]**; verify against Apple docs.

---

## 3. OS-provided models callable by third-party apps

### Takeaway
All three OS vendors expose a small on-device LLM, but each is gated: Apple's Foundation Models needs an Apple-Intelligence-eligible device with a supported system language and gives a 4,096-token on-device context; Android's Gemini Nano (ML Kit GenAI / AICore) is limited to a list of mostly flagship phones, is foreground-only and quota-limited; Windows Phi Silica needs a Copilot+ PC, package identity and a Limited Access Feature token; Chrome's built-in Prompt API is Google-Chrome-only and is not available to Chromium embedders such as CEF (and by inference Electron). They are useful as opportunistic "free" tiers reachable through Capacitor plugins on mobile, never as the only path.

### Cited Findings

Apple Foundation Models (iOS/iPadOS/macOS 26 and 27)
- Context window: 4,096 tokens per `LanguageModelSession`, shared by instructions, prompts, tool definitions, tool outputs and responses; from 26.4 the limit can be read at runtime via `SystemLanguageModel.default.contextSize` and may change with model updates — [Apple TN3193](https://developer.apple.com/tutorials/data/documentation/technotes/tn3193-managing-the-on-device-foundation-model-s-context-window.md); [Apple docs: Managing the context window](https://developer.apple.com/documentation/foundationmodels/managing-the-context-window.md)
- Apple Frameworks Engineer (forum, 2026): on-device model has a 4K context window; guided generation supports any schema representable in JSON and guarantees tool arguments follow the schema; images can be passed (any number that fits the context; framework may resize); there is no model-version pinning or version-retrieval API and the model changes across OS releases (use the Evaluations framework); the OS limits concurrent requests (requests may be delayed, not errored) and background access on iOS may be throttled or cancelled **[read]** — [Apple Developer Forums 833642](https://developer.apple.com/forums/thread/833642)
- Non-Apple poster in the same thread (summarising WWDC26 labs): Private Cloud Compute tier has a 32K context — [Apple Developer Forums 833642](https://developer.apple.com/forums/thread/833642) **[unverified]**
- A blog claims the on-device context grows to 8,000 tokens on iOS 27; not confirmed by Apple documentation found here — [ninetwothree blog](https://www.ninetwothree.co/blog/wwdc-2026-on-device-ai) **[unverified; conflicts with Apple engineer's "4K" statement in the same year]**
- WWDC26: session 241 "What's new in the Foundation Models framework" covers vision (image input) capabilities; press reports a new `LanguageModel` protocol for third-party/cloud providers, free access to Apple's PCC models for developers under 2 million first-time downloads, and a Gemini preview — [Apple WWDC26 session 241](https://developer.apple.com/videos/play/wwdc2026/241/); [FoneArena](https://www.fonearena.com/blog/484623/apple-wwdc26-foundation-models-gemini-support-xcode-27-agentic-coding-tools.html) (cloud features are irrelevant to the offline requirement)
- Device eligibility: Apple-Intelligence-capable devices only — iPhone 15 Pro, iPhone 16 series and later, and any iPad or Mac with Apple silicon that supports Apple Intelligence, with Apple Intelligence enabled — [InfoQ](https://www.infoq.com/news/2025/07/apple-foundation-models-ios26); [Cult of Mac](https://www.cultofmac.com/news/apple-foundation-models-framework)
- Language gating: the framework requires the device system language to be a supported Apple Intelligence language; developers have complained that this makes it unavailable to many users and asked for a per-app override — [Apple Developer Forums 805378](https://developer.apple.com/forums/thread/805378)
- Apple Intelligence languages (late 2025): English, Danish, Dutch, French, German, Italian, Norwegian, Portuguese, Spanish, Swedish, Turkish, Vietnamese, Chinese (simplified and traditional), Japanese, Korean — [Apple Newsroom](https://www.apple.com/hk/en/newsroom/2025/11/apple-intelligence-expands-to-new-languages-including-traditional-chinese/)
- Adapters: per an informal Q&A with Apple framework engineers, custom adapters are ~150–160 MB each and can be shipped through Background Assets — [gist of WWDC25 group-lab notes](https://gist.github.com/samhenrigold/3aad01b762ccc87e34e6115055daac2f) **[informal]**
- Apple's 2024 on-device model ran at about 30 tok/s on iPhone 15 Pro; the 2025 tech report describes KV-cache sharing cutting KV memory by 37.5% — [Apple Foundation Models Tech Report 2025](https://machinelearning.apple.com/research/apple-foundation-models-tech-report-2025); [arXiv 2507.13575](https://arxiv.org/html/2507.13575v3)

Apple speech
- SpeechAnalyzer / SpeechTranscriber (iOS/iPadOS/macOS 26): fully on-device, long-form oriented, model assets downloaded and managed by the system (not counted in app size); `DictationTranscriber` is the fallback for unsupported languages/devices; not on watchOS — [WWDC25 session 277 index](https://nonstrict.eu/wwdcindex/wwdc2025/277/); [Callstack](https://www.callstack.com/blog/on-device-speech-transcription-with-apple-speechanalyzer); [Addpipe blog](https://blog.addpipe.com/apple-speechanalyzer-api/)
- Language count is inconsistently reported (a ~10-language launch list in one blog vs "thirty" in another) — [Addpipe blog](https://blog.addpipe.com/apple-speechanalyzer-api/); [blakecrosley.com](https://blakecrosley.com/blog/speech-framework-vs-sfspeechrecognizer) **[conflict]**

Android: ML Kit GenAI / AICore / Gemini Nano
- ML Kit GenAI APIs run on Gemini Nano through AICore; the Prompt API artefact is `com.google.mlkit:genai-prompt` (1.0.0-beta2 in the get-started guide; beta3 used in a July 2026 Android blog) — [ML Kit GenAI overview](https://developers.google.com/ml-kit/genai) **[extract only]**; [Prompt API get started](https://developers.google.com/ml-kit/genai/prompt/android/get-started) **[extract only]**; [Android Developers Blog, July 2026](https://android-developers.googleblog.com/2026/07/android-on-device-inference.html)
- Device support is by named device and model generation: "nano-v2" list includes Honor Magic V5 / Magic 7 / Magic 7 Pro, iQOO 13, Motorola Razr 60 Ultra / Razr Ultra 2025 (list truncated in extract); Pixel 10 series runs nano-v3 and is where the Prompt API "performs best" — [ML Kit GenAI overview](https://developers.google.com/ml-kit/genai) **[extract only]**; [Android Developers blog](https://developer.android.com/blog/posts/ml-kit-s-prompt-api-unlock-custom-on-device-gemini-nano-experiences)
- Quota: AICore enforces a per-app inference quota; exceeding a longer-duration (e.g. daily) quota returns `ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED` — [ML Kit GenAI overview](https://developers.google.com/ml-kit/genai) **[extract only]**
- Foreground-only: inference is allowed only from the top foreground app; background calls (including from foreground services) are rejected — reported by a conference-talk page citing the ML Kit documentation as of August 2026 — [AI Engineer Europe 2026 talk page](https://www.ai.engineer/talks/owH1f0N-keY-gemini-nano-on-device) **[secondary]**

Windows: Phi Silica / Windows AI APIs
- Phi Silica requires a Copilot+ PC (NPU, 40+ TOPS): Snapdragon X series, Intel Core Ultra 200V series, AMD Ryzen AI 300 series; Microsoft recommends Foundry Local or cloud as fallback on other hardware — [Microsoft Learn: Windows AI comparison](https://learn.microsoft.com/windows/ai/windows-ai-comparison) **[extract only]**; [Microsoft Learn: Phi Silica](https://learn.microsoft.com/windows/ai/apis/phi-silica) **[extract only]**
- Phi Silica APIs are a Limited Access Feature: an unlock token must be requested via Microsoft's LAF form and passed with an attestation string; experimental-channel releases do not require the token — [Microsoft Learn: Phi Silica](https://learn.microsoft.com/windows/ai/apis/phi-silica) **[extract only]**; [Microsoft Learn: troubleshooting](https://learn.microsoft.com/en-us/windows/ai/apis/troubleshooting) **[extract only]**
- Apps must have package identity at runtime and declare the `systemAIModels` capability; minimum OS version 10.0.26100.0 (lower minimum silently ignores the capability) — [Microsoft Learn: troubleshooting](https://learn.microsoft.com/en-us/windows/ai/apis/troubleshooting) **[extract only]**; [Microsoft Learn: Phi Silica WinUI tutorial (zh-cn)](https://learn.microsoft.com/zh-cn/windows/ai/apis/phi-silica-winui-tutorial) **[extract only]**
- Phi Silica is not available in China; Microsoft was testing Phi Silica on Nvidia RTX GPUs in June 2026 (test only) — [Microsoft Learn: Phi Silica](https://learn.microsoft.com/windows/ai/apis/phi-silica) **[extract only]**; [WinBuzzer](https://winbuzzer.com/2026/06/15/microsoft-tests-phi-silica-for-windows-ai-on-nvidia-gpus-xcxwbn/) **[secondary]**

Chrome built-in AI (Prompt API, Gemini Nano)
- Hardware requirements: ≥22 GB free on the Chrome profile volume; GPU path needs >4 GB VRAM; CPU path needs ≥16 GB RAM and ≥4 cores; audio input requires a GPU; not supported in Chrome for Android, iOS or non-Chromebook-Plus ChromeOS — [Chrome for Developers: Prompt API](https://developer.chrome.com/docs/ai/prompt-api)
- Prompt API shipped for Chrome Extensions in Chrome 138 stable; web-page exposure followed (official page references Chrome 148) — [Chrome for Developers: Prompt API (extensions)](https://developer.chrome.com/docs/extensions/ai/prompt-api); [blink-dev Intent to Ship: Prompt API](https://groups.google.com/a/chromium.org/g/blink-dev/c/iR6R7-nQeHI)
- Embedders: the CEF project's issue states built-in AI "depends on Google-internal (Google Chrome only) code that is not publicly available to Chromium/CEF" — [chromiumembedded/cef#3982](https://github.com/chromiumembedded/cef/issues/3982)
- Electron's own answer is a separate package that mimics the API on top of node-llama-cpp with a user-supplied GGUF, not a bridge to Gemini Nano — [electron/llm](https://github.com/electron/llm)

### Inferences
- Chrome's Prompt API should be treated as unavailable inside Electron (same Chromium-embedder limitation as CEF; the existence of `@electron/llm` corroborates). Also unavailable in Android WebView and WKWebView.
- Reaching OS models: iOS/iPadOS/macOS — Foundation Models and SpeechAnalyzer are Swift-only, so a Capacitor plugin on mobile (existing: `@capacitor/local-llm`, `@capgo/capacitor-llm`) and, on macOS/Electron, a small signed Swift helper/sidecar or native Node addon. Android — ML Kit GenAI via the same Capacitor plugins. Windows — Phi Silica needs WinAppSDK + MSIX/package identity + LAF token, which is awkward for an MIT open-source Electron app (the token is per-publisher and forks could not reuse it); Foundry Local is the more open route.
- For an AAC/eye-typing keyboard, the 4,096-token Apple context and Android's foreground-only/quota rules are tolerable for short next-phrase prediction but the unpinnable, OS-updated model means behaviour can change under the app; a bundled open model should remain the reference path, with OS models as an opt-in "zero-download" tier.
- Apple Foundation Models adapters (~150 MB, tied to a specific base-model version) are impractical for a small team because every OS model update would require retraining.

### Gaps
- Official Apple device-eligibility table and Foundation Models guardrail behaviour/documentation were not retrieved; the claim that guardrails cannot be disabled is [background] and unverified here.
- ML Kit GenAI full device list, exact quota numbers, LoRA support in AICore, and Android on-device `SpeechRecognizer.createOnDeviceSpeechRecognizer` details could not be read (developers.google.com blocked; no search performed for the last item).
- AVSpeechSynthesizer details (voices, personal voice entitlement) not researched.
- Whether Windows AI APIs/Phi Silica can be called from an unpackaged Electron app with "package identity via sparse package" was not verified.

---

## 4. Hardware reality: memory budgets, thermals, NPUs, tokens-per-second by device class

### Takeaway
Practical ceilings are set by memory and heat rather than peak compute: iOS apps get roughly half of device RAM (about 6 GB reported on 8–12 GB iPhones even with the increased-memory entitlement), Android has no fixed native cap but kills on system pressure, and sustained inference on phones throttles within minutes. Rough decode speeds for 4-bit models: 1B ≈ 45 tok/s on an 8 GB M1 and ≈ 170–240 tok/s on M4 Pro (MLX); 3B ≈ 24–29 tok/s on M1 and ≈ 90–105 tok/s on M4 Pro; ≈ 18–40 tok/s for 3–4B on Snapdragon X Elite (CPU vs NPU); ≈ 50 tok/s for Gemma 4 E2B on flagship phone GPUs; and (weakly sourced) ≈ 18–28 tok/s for 1B on Snapdragon 7 Gen 3 / Dimensity 8300 CPUs.

### Cited Findings

Memory — iOS/iPadOS
- The `com.apple.developer.kernel.increased-memory-limit` entitlement tells the system the app may perform better by exceeding the default limit; Apple notes the higher limit is only available on some device models and publishes no numbers — [Apple entitlement docs](https://developer.apple.com/tutorials/data/documentation/bundleresources/entitlements/com.apple.developer.kernel.increased-memory-limit.md)
- Developer measurements (2026): with the entitlement, ~6144 MB per process on a 12 GB iPhone (≈6656 MB with the debugging variant); a separate report gives the same ~6 GB ceiling on an 8 GB iPhone 16 Pro Max — [Apple Developer Forums 834805](https://developer.apple.com/forums/thread/834805) **[anecdotal]**
- Reports are inconsistent: one developer saw ~15 GB before termination on an iPad in development but no effect in the App Store build; another saw only a slight increase — [Apple Developer Forums 770868](https://developer.apple.com/forums/thread/770868); [Apple Developer Forums 740831](https://developer.apple.com/forums/thread/740831)
- llama.rn recommends enabling both Extended Virtual Addressing and Increased Memory Limit for LLM apps on iOS **[read]** — [mybigday/llama.rn](https://github.com/mybigday/llama.rn)

Memory — Android
- Android has a per-app Java heap limit (raised by `largeHeap`), but lmkd kills processes on system memory pressure by oom_adj priority; since Android 10 lmkd uses PSI monitors — [Android Developers: memory management](https://developer.android.com/topic/performance/memory-management); [AOSP lmkd](https://source.android.com/docs/core/perf/lmkd)
- There is no API to detect native memory pressure before the kill, and trim callbacks have not prevented LMKs; `ApplicationExitInfo` shows the low-memory reason after the fact — [Android Developers: Low memory killers](https://developer.android.com/games/optimize/vitals/lmk)
- Unofficial claims: Android kills apps around ~6 GB process memory regardless of device RAM; Android 17 adds a memory limiter counting native anonymous memory (kills reported as `REASON_OTHER` / "MemoryLimiter:AnonSwap") — [Nutrient blog](https://www.nutrient.io/blog/android-pdf-out-of-memory-handling/); [stora.sh blog](https://stora.sh/blog/2026-04-25-android-17-memory-limits-guide) **[unverified]**
- Model memory example: Llama 3.2 3B 4-bit ≈ 1.8 GB on disk and ≈ 3 GB peak RAM (MLX guide) — [bestllmfor.com](https://bestllmfor.com/how-to/install-mlx-llama-mac/) **[unverified]**

Thermals and battery
- Sustained-load benchmark (arXiv 2603.23640, March 2026; quantised 1.5B model, 20 back-to-back iterations on phones, an NPU and a GPU): sustained LLM inference on mobile SoCs is "primarily limited by thermal management rather than peak compute"; iPhone 16 Pro showed rapid thermal-state transitions and sustained degradation once "Hot"; the inter-iteration gap was too short for thermal recovery — [arXiv 2603.23640](https://arxiv.org/abs/2603.23640) **[extract only]**
- Earlier study (2024): 0.16–0.21 mWh per token across phones/edge devices; iPhone 14 Pro surface reached 47.9 °C with throttling — [alphaxiv overview of arXiv 2403.12844](https://www.alphaxiv.org/overview/2403.12844) **[extract only; older figure]**
- Blog anecdotes: Snapdragon 8 Gen 2 with a 7B model throttled after 90–120 s (18 → 11–13 tok/s); iPhone 14 Pro 18 tok/s for 40 s then 7 tok/s — [omr.it.com](https://omr.it.com/blog/thermal-throttling-mobile-llm-inference/) **[unverified]**

Tokens per second (decode), by device class

| Device | Model / quant | Runtime | Decode tok/s | Source |
|---|---|---|---|---|
| M1, 8 GB | Llama 3.2 1B (quant not stated), 4k ctx | MLX (oMLX app) | ~45 (prefill ~801) | [omlx.ai community benchmark](https://omlx.ai/benchmarks/2o9iujdf) [community] |
| M1 8-core, 16 GB | Llama 3.2 3B 4-bit | MLX (oMLX) | ~24 (4k ctx) – ~29 (1k) | [omlx.ai community benchmarks](https://omlx.ai/benchmarks?page=3674) [community] |
| M4 Pro, 24 GB | Llama 3.2 1B 4-bit | MLX (oMLX) | ~169 (4k) – ~238 (1k) | [omlx.ai community benchmarks](https://omlx.ai/benchmarks?page=27155) [community] |
| M4 Pro, 48 GB | Llama 3.2 3B 4-bit | MLX (oMLX) | ~87 (4k) – ~105 (1k) | [omlx.ai community benchmarks](https://omlx.ai/benchmarks?page=3674) [community] |
| M1 Max | Llama 3.1 8B Int4 | Core ML (GPU) | ~33 | [Apple ML Research](https://machinelearning.apple.com/research/core-ml-on-device-llama) |
| M3 laptop | 3B 4-bit | WebLLM in browser | 90 | [arXiv 2412.15803](https://arxiv.org/html/2412.15803v1) |
| Snapdragon X Elite (X1E-80-100, 32 GB) | Llama 3.2 3B Q4_0 | llama.cpp NPU vs CPU | 41.2 vs 17.8 | [specpicks.com](https://specpicks.com/reviews/llama-cpp-snapdragon-hexagon-npu-benchmarks-2026) [unverified] |
| Snapdragon X Elite | Phi-4-mini 3.8B | Foundry Local NPU vs Ollama CPU | 32.1 vs 18.6 | [bestllmfor.com](https://bestllmfor.com/best/snapdragon-x-copilot/) [unverified] |
| iPhone 17 Pro | Gemma 4 E2B | LiteRT-LM GPU / CPU | 56.5 / 25.0 | [HF model card](https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm) [extract only] |
| iPhone 17 Pro (A19 Pro) | Gemma 4 E2B | AI Edge Gallery GPU / CPU | 51.28 / 36.99 | [Beebom](https://gadgets.beebom.com/stories/i-tested-on-device-ai-on-android-and-iphone-results-not-even-close) |
| iPhone 15 Pro | Apple on-device model (~3B) | Apple stack | ~30 | [Apple tech report](https://machinelearning.apple.com/research/apple-foundation-models-tech-report-2025) |
| Samsung S26 Ultra | Gemma 4 E2B | LiteRT-LM GPU (OpenCL) | 52.1 (up to 2.2x with MTP) | [HF model card](https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm) [extract only] |
| Snapdragon 8 Elite Gen 5 phone | Gemma 4 E2B | AI Edge Gallery GPU | 48.55 | [Beebom](https://gadgets.beebom.com/stories/i-tested-on-device-ai-on-android-and-iphone-results-not-even-close) |
| Pixel 9 Pro / Pixel 7 | Llama 3.2 3B Q4_K_M | llama.cpp CPU | ~12 / ~7.5 | [r/LocalLLaMA mirror](https://redlib.hbubli.cc/r/LocalLLaMA/comments/1glx6a5/phone_llms_benchmarks) [community, 2024] |
| Snapdragon 7 Gen 3 | 1B Q4_K_M, 2048 ctx | llama.cpp CPU | ~18–25 | [ertas.ai](https://www.ertas.ai/blog/llm-android-benchmarks-snapdragon-tensor) [unverified, vendor blog] |
| Dimensity 8300 | 1B Q4_K_M | llama.cpp CPU | ~20–28 | [ertas.ai](https://www.ertas.ai/blog/llm-android-benchmarks-snapdragon-tensor) [unverified] |
| Android flagships 2024 (OnePlus 12 class) | Llama 3.2 1B | ExecuTorch XNNPACK | ~19 | [ExecuTorch example README mirror](https://android.googlesource.com/platform/external/executorch/+/afb26644c/examples/models/llama2/README.md) [older] |

- Human reading speed is about 4–7 tokens/s (Qualcomm's framing), a useful floor for "usable" generation — [Qualcomm developer blog](https://www.qualcomm.com/developer/blog/2026/04/llama-models-acceleration-on-cpu-qmx)
- Qualcomm's marketing figure for Snapdragon X Elite is "30 tokens per second" for a 7B model (2023 launch claim, conditions unclear) — [Qualcomm product page](https://www.qualcomm.com/products/mobile/snapdragon/pcs-and-tablets/snapdragon-x-elite)

NPU access reality
- Phone NPU for LLMs is Android-only in LiteRT-LM and prone to driver crashes; llama.rn's Hexagon path is "experimental" and limited to Snapdragon 8 Gen 1+ — [dev.to](https://dev.to/samdude/gemma-4-on-android-tricks-for-faster-on-device-inference-3kj5) **[unverified]**; [mybigday/llama.rn](https://github.com/mybigday/llama.rn)
- WebNN (the only web route to NPUs) is CPU-only on Android and not shipped — [blink-dev archive](https://mid.mail-archive.com/blink-dev@chromium.org/msg15857.html)

### Inferences
- Device-class memory budgets for all models combined (weights + KV cache + runtime), conservative planning figures derived from the above: 4 GB phone/tablet ≈ 1–1.5 GB native (sub-1B LM only); 6 GB ≈ 2 GB (1B LLM 4-bit + ASR + TTS); 8 GB iPhone/iPad/Android ≈ 3–4 GB (a 3–4B 4-bit LLM is possible only if ASR/TTS are small and nothing else is resident); 8 GB Mac ≈ 3–4 GB (unified memory shared with the OS and Electron's own ~0.5–1 GB); 16 GB Mac/PC ≈ 6–8 GB. These are inferences, not measured limits.
- For an 8 GB M1, MLX figures imply 1B at ~45 tok/s and 3B at roughly 20–25 tok/s — comfortably interactive for short completions. An ordinary Windows laptop without a discrete GPU is the weakest desktop class: no primary benchmark was found, but Snapdragon X CPU results (≈18 tok/s for 3–4B) suggest mainstream x86 laptop CPUs will be at or below that for 3B and should default to ≤1B.
- Mid-range Android tablets (Snapdragon 6/7, Dimensity 7xxx, Exynos 13xx/14xx) should be assumed CPU-only for LLMs: 1B at ~10–25 tok/s (weak sources), 3B likely <10 tok/s and thermally unsustainable. A sub-300M LM is the realistic always-on predictor there.
- Always-on streaming ASR plus periodic LLM bursts keeps the SoC warm; the sustained-load paper implies steady-state throughput should be budgeted at the throttled plateau, and LLM calls should be short (tens of tokens), rate-limited and cancellable.
- NPUs are worth targeting only where an OS/vendor layer abstracts them (Apple's own models via ANE, Windows via Foundry Local/WinML EPs, AICore on Android). Direct NPU integration (QNN, MediaTek NeuroPilot, Exynos) per SoC is not practical for a small team.

### Gaps
- No primary, methodologically clean tokens/sec for: Intel/AMD laptop CPUs (Core Ultra, Ryzen) on 1B and 3–4B Q4; iPhone 15/16 and A16 iPad with open models; M-series iPad; Snapdragon 7-series and Dimensity mid-range with 3B models; Intel Core Ultra / AMD Ryzen AI NPUs.
- No official per-device jetsam table from Apple; ~6 GB figure is anecdotal. Whether the increased-memory entitlement applies to WKWebView's WebContent process was reported negatively in a search extract whose URL could not be pinned — treat as unverified.
- Quantified battery drain (%/hour) for always-on ASR + periodic LLM was not found.
- arXiv primary texts (2603.23640, 2603.26603, 2410.03613) could not be opened; numbers above are from abstracts/search extracts.

---

## 5. Running several models at once; reference architectures

### Takeaway
Open voice stacks converge on a cascaded, streaming pipeline — VAD (and optional wake word) gating a streaming ASR, a text LLM, and a TTS that starts speaking before the LLM finishes — with each stage as a separately loadable service. For a memory-constrained device the pattern translates to: keep tiny models (VAD, streaming ASR, small predictor LM, small TTS) resident, and load the 1–4B LLM on demand (memory-mapped, single instance, unloaded on memory warning).

### Cited Findings
- Kyutai Unmute: cascaded STT → any text LLM → TTS; semantic VAD decides end-of-turn; TTS begins before the full LLM response exists; trade-off acknowledged — the text LLM loses prosody/emotion information — [kyutai.org/unmute](https://kyutai.org/unmute/)
- Unmute service wiring (third-party docs mirror): browser ↔ backend JSON over WebSocket; backend ↔ STT MessagePack over WebSocket; backend ↔ LLM HTTP streaming (SSE); STT model 1B parameters (EN/FR) with ~200 ms delay; ~1.15–1.45 s total latency on L40S GPUs; requires CUDA GPU with 16 GB+ VRAM, x86_64 Linux/WSL — i.e. a server reference design, not on-device — [Mintlify mirror: architecture](https://www.mintlify.com/kyutai-labs/unmute/architecture/overview); [Mintlify mirror: requirements](https://www.mintlify.com/kyutai-labs/unmute/requirements) **[secondary mirror]**
- Home Assistant Assist pipeline: four stages — wake word detection, speech-to-text, intent recognition, text-to-speech — run through a WebSocket API; a run can start at any stage and end at a later one — [Home Assistant developer docs](https://developers.home-assistant.io/docs/voice/pipelines/)
- Wyoming protocol standardises communication between STT, TTS and wake-word engines (each can run on the same or another machine); typical local stack is openWakeWord → Whisper → intent engine → Piper — [kunalganglani.com guide](https://www.kunalganglani.com/blog/local-ai-voice-assistant-whisper-piper-ollama) **[secondary]**
- Handy (open-source offline dictation, Tauri: Rust backend + React/TS web UI; Windows/macOS/Linux): Silero VAD filters silence so only speech reaches the model; Whisper-family models via a whisper library (GPU recommended) and Parakeet V3 via a CPU-optimised library (CPU-only, Intel 6th gen or newer); cpal for audio I/O; push-to-talk default; output pasted into the active field — [cjpais/Handy](https://github.com/cjpais/Handy); [Better Stack guide](https://betterstack.com/community/guides/ai/handy-offline.md)
- llama.rn supports slot-based parallel decoding with queue management, embeddings and experimental TTS in the same runtime, showing that one llama.cpp process can multiplex several small workloads **[read]** — [mybigday/llama.rn](https://github.com/mybigday/llama.rn)
- LiteRT-LM lists speech models (Qwen3-ASR, Kokoro, Qwen3-TTS) alongside Gemma, i.e. Google's stack is moving towards ASR + LLM + TTS in one runtime **[read]** — [google-ai-edge/LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM)
- Apple's Foundation Models: the OS limits concurrent model requests and may delay them; background requests on iOS may be throttled or cancelled **[read]** — [Apple Developer Forums 833642](https://developer.apple.com/forums/thread/833642)
- WebLLM recommends Web Worker / Service Worker hosting so the model survives page navigation and does not block the UI **[read]** — [mlc-ai/web-llm](https://github.com/mlc-ai/web-llm)

### Inferences
- Handy is the closest architectural analogue to this project (web-tech UI + native inference core + VAD-gated ASR + CPU-first Parakeet / GPU Whisper selection); its Tauri/Rust split maps directly to Electron main/utility process and to a Capacitor native plugin.
- Suggested scheduling for this app: (1) VAD always on (≈1–2 MB model, negligible CPU); (2) streaming ASR resident and run only on VAD-positive audio; (3) small predictor LM (n-gram or ≤300M) resident with a warm KV cache of the current context so each keystroke/gaze event costs only incremental tokens; (4) TTS resident if small (tens of MB), otherwise loaded on first speak; (5) the 1–4B LLM memory-mapped and loaded lazily, with a single shared instance, an idle-unload timer and immediate unload on OS memory warnings; (6) never run LLM generation concurrently with TTS synthesis on phones — serialise heavy stages on one inference queue with priorities (ASR > TTS > predictor > LLM) and make LLM generation cancellable.
- Memory sharing: GGUF via mmap lets the OS page weights out under pressure (slow but avoids kills); models loaded inside a web view cannot be shared with native code, another reason to keep all weights native-side on mobile.
- Because TTS can start on the first clause (Unmute pattern), perceived latency depends on ASR finalisation + LLM time-to-first-clause, so prefill speed and prompt caching matter more than peak decode speed.

### Gaps
- Pipecat local pipelines, LiveKit local agents, Moshi on-device (MLX/Rust), WhisperKit + MLX demo apps, Cactus and Google AI Edge Gallery internals were not researched individually this session; no source found describing their memory-sharing or load/unload policies.
- No published measurements of concurrent ASR + LLM + TTS memory/latency on a single phone were found.

---

## 6. Distribution constraints

### Takeaway
Model weights should be downloaded after install on every platform: Play allows AI packs up to 1.5 GB each (4 GB cumulative app size, no code inside packs), Apple offers Background Assets / Apple-hosted asset packs (on-demand resources are deprecated from iOS 27), and both stores gate large cellular downloads at 200 MB. Downloading weights is generally treated as data rather than code under Apple guideline 2.5.2 (per informal Apple DTS statements), but that boundary is not written into the guideline.

### Cited Findings
- Google Play for On-device AI (beta): individual AI packs up to 1.5 GB (compressed download size); maximum cumulative app size 4 GB; delivery install-time, fast-follow or on-demand; AI packs "only contain models. Java/Kotlin and native libraries are not allowed"; packs update with the app binary (unchanged packs are not re-downloaded); device targeting by SoC, device model, RAM (min/max bytes) and system features; downloads over 200 MB wait for Wi-Fi unless the user consents; models must not be offered to other apps; requires AGP 8.8+ (8.10+ for device targeting); library `com.google.android.play:ai-delivery:0.1.1-alpha01` **[read]** — [Android Developers: Play for On-device AI](https://developer.android.com/google/play/on-device-ai)
- Practitioner account of shipping a 584 MB Gemma model via Google Play — [ProAndroidDev](https://proandroiddev.com/shipping-a-584-mb-gemma-model-through-google-play-b4df1825c6b8)
- Apple: on-demand resources are deprecated as of iOS 27 in favour of Background Assets; Apple's size table lists asset-pack limits of 20 GB (earlier iOS) and 70 GB (iOS 18+) for App Store-hosted thinned asset packs — [App Store Connect Help: ODR size limits](https://developer.apple.com/help/app-store-connect/reference/on-demand-resources-size-limits/)
- Apple-hosted Managed Background Assets (WWDC25 session 325) handle download, update and compression of asset packs for the app — [Apple WWDC25 session 325](https://developer.apple.com/videos/play/wwdc2025/325); size-limit discussion — [Apple Developer Forums 855058](https://developer.apple.com/forums/thread/855058); [Apple Developer Forums 815344](https://developer.apple.com/forums/thread/815344)
- Apple cellular alert threshold: additional content counts towards the download size that triggers the cellular-network alert at 200 MB (forum answer) — [Apple Developer Forums 815344](https://developer.apple.com/forums/thread/815344) **[forum answer]**
- Guideline 2.5.2: Apple DTS engineers have said that updating an app's ML models after installation "isn't in conflict with App Store guidelines" and that existing apps depend on it (informal forum statement); a 2026 commentary notes stricter 2.5.2 enforcement against apps whose behaviour is defined by downloaded code — [Apple Developer Forums 793131](https://developer.apple.com/forums/thread/793131) **[extract only; thread attribution not re-verified]**; [stora.sh commentary](https://stora.sh/blog/2026-04-30-apple-2-5-2-vibe-coding-crackdown) **[secondary]**; practical bundling-vs-download discussion — [ertas.ai](https://www.ertas.ai/blog/ship-gguf-model-app-store-bundle-download) **[vendor blog]**
- Foundation Models custom adapters can be distributed via Background Assets — [WWDC25 group-lab notes gist](https://gist.github.com/samhenrigold/3aad01b762ccc87e34e6115055daac2f) **[informal]**
- node-llama-cpp ships prebuilt binaries per platform and otherwise compiles llama.cpp from source at install — relevant because Electron packaging must include the right prebuilt and disable the source-build fallback **[read]** — [withcatai/node-llama-cpp](https://github.com/withcatai/node-llama-cpp)
- llama.rn downloads prebuilt native binaries in `postinstall` with SHA-256 verification, and Android OpenCL/Hexagon paths require `uses-native-library` manifest entries (`libOpenCL.so`, `libcdsprpc.so`) **[read]** — [mybigday/llama.rn](https://github.com/mybigday/llama.rn)
- GPU driver variability: llama.cpp's OpenCL doc excludes Adreno 6xx phones for outdated drivers and notes non-optimal results on Intel GPUs; LiteRT-LM NPU crashes are attributed to driver fragmentation — [llama.cpp OPENCL.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/OPENCL.md); [dev.to](https://dev.to/samdude/gemma-4-on-android-tricks-for-faster-on-device-inference-3kj5) **[unverified]**

### Inferences
- Recommended delivery: ship the app with only tier-0/tier-1 assets (n-gram tables, VAD, possibly a <100 MB predictor) inside the binary; fetch larger models in-app from the project's own release hosting (works identically on all four platforms and for sideloaded/desktop builds), with Play AI packs and Apple Background Assets as store-native alternatives. Use resumable, checksummed downloads and require Wi-Fi/consent above 200 MB to match store behaviour.
- Weight licences matter as much as runtime licences: an MIT app can download Apache/MIT weights freely, but Gemma (Gemma terms), Llama (Meta community licence) and similar are redistributed under their own terms — offer them as user-initiated downloads with licence display rather than bundling. (Model catalogue is covered by other researchers.)
- Electron: every native binary (N-API `.node` addons, sidecar executables, dylibs/DLLs) must be unpacked from ASAR, code-signed and, on macOS, notarised with hardened runtime; a JIT or unsigned-memory entitlement may be required for some runtimes. This is [background] knowledge — electronjs.org could not be fetched to cite.
- On Windows, default to CPU (and optionally Vulkan with a start-up self-test and automatic fallback) because integrated-GPU driver quality varies; never make GPU a hard requirement.

### Gaps
- Electron code-signing/notarisation requirements for sidecars could not be cited from a primary source (www.electronjs.org blocked).
- Exact App Store app-size limits (binary cap) and current Background Assets per-pack limits were not confirmed; the 20/70 GB figures are from Apple's ODR size table extract.
- The 2.5.2 "weights are not code" position rests on an informal DTS forum answer, not on guideline text; no App Review precedent list was found.
- Mac App Store sandbox implications for a llama.cpp sidecar and Microsoft Store/MSIX rules were not researched.

---

## 7. Recommended deployment architecture and capability tiers

### Takeaway
Use one portable native core everywhere (llama.cpp/GGUF for language models, sherpa-onnx/ONNX for VAD + streaming ASR + TTS), keep only UI and tiny models in the web view, expose the core through a single TypeScript "inference provider" interface implemented by an Electron utility-process addon on desktop and a Capacitor native plugin on mobile, and add per-platform accelerators (MLX or OS models on Apple, LiteRT-LM GPU on Android, Foundry Local NPU on Copilot+ PCs) as optional providers selected by a start-up capability probe that assigns a tier.

### Cited Findings (evidence underlying the recommendation)
- llama.cpp bindings exist for Electron (node-llama-cpp, MIT, Metal/CUDA/Vulkan prebuilt) and for Capacitor/React Native (MIT) — [node-llama-cpp](https://github.com/withcatai/node-llama-cpp); [llama.rn](https://github.com/mybigday/llama.rn); [llama-cpp-capacitor](https://github.com/arusatech/llama-cpp)
- sherpa-onnx covers all four OSes plus Node/WASM with ASR, TTS, VAD under Apache-2.0 — [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
- WKWebView memory is not raiseable and WASM has ~300 MB reliable headroom on iOS — [WebKit Bugzilla 269777](https://bugs.webkit.org/show_bug.cgi?id=269777); [Apple Developer Forums 766309](https://developer.apple.com/forums/thread/766309)
- Flagship phone GPUs reach ~50 tok/s on a ~2B-effective model with LiteRT-LM — [Beebom](https://gadgets.beebom.com/stories/i-tested-on-device-ai-on-android-and-iphone-results-not-even-close)
- 8 GB M1 reaches ~45 tok/s on 1B and M1 16 GB ~24–29 tok/s on 3B 4-bit with MLX — [omlx.ai](https://omlx.ai/benchmarks/2o9iujdf); [omlx.ai](https://omlx.ai/benchmarks?page=3674)
- OS models are reachable from Capacitor through existing plugins but are device/language/foreground gated — [Capgo plugin docs](https://capgo.app/docs/plugins/llm/); [Apple Developer Forums 805378](https://developer.apple.com/forums/thread/805378); [AI Engineer talk page](https://www.ai.engineer/talks/owH1f0N-keY-gemini-nano-on-device)
- Play device targeting can deliver different model packs by RAM/SoC — [Android Developers](https://developer.android.com/google/play/on-device-ai)

### Inferences (the recommendation itself — all of this section is the researcher's synthesis)

Engine per platform per task

| Task | macOS (Electron) | Windows (Electron) | iPadOS/iOS (Capacitor) | Android (Capacitor) |
|---|---|---|---|---|
| VAD | sherpa-onnx (Silero) in utility process; or ORT-Web WASM in renderer | same | sherpa-onnx in native plugin | sherpa-onnx in native plugin |
| Streaming ASR | sherpa-onnx (CPU); optional SpeechAnalyzer via Swift helper | sherpa-onnx (CPU) | sherpa-onnx or SpeechAnalyzer (OS 26+) | sherpa-onnx (CPU; QNN optional) |
| TTS (small) | sherpa-onnx (Piper/Kokoro-class) | sherpa-onnx | sherpa-onnx; AVSpeechSynthesizer as tier-0 fallback | sherpa-onnx; Android TextToSpeech as tier-0 fallback |
| Predictor LM (≤300M) | llama.cpp via node-llama-cpp (Metal) | llama.cpp CPU | llama.cpp (Metal) in plugin | llama.cpp CPU in plugin |
| 1B LLM | llama.cpp Metal (optionally MLX sidecar) | llama.cpp CPU/Vulkan; Foundry Local on Copilot+ | llama.cpp Metal; or Foundation Models when eligible | llama.cpp CPU; LiteRT-LM GPU; or Gemini Nano when eligible |
| 3–4B LLM | llama.cpp Metal / MLX (16 GB; 8 GB with care) | llama.cpp Vulkan/CPU on 16 GB; Foundry Local NPU on Copilot+ | 8 GB devices only (iPhone 15 Pro+/M-series iPad), increased-memory entitlement | 8 GB+ flagship-class only; LiteRT-LM GPU preferred |
| Embeddings / small vision | transformers.js v4 WebGPU in renderer/worker, or llama.cpp embeddings | same (WASM fallback) | native (llama.cpp / Core ML) — not in WKWebView if >100 MB | native; WebView only for tiny models |
| Neural voice-cloning TTS | native sidecar, GPU | 16 GB + GPU/NPU only | M-series iPad / 8 GB iPhone only, on demand | not recommended on mid-range |

What lives where
- Web view (shared UI code): all UI, gaze/keyboard logic, n-gram predictor (JS/WASM), optional tiny WASM/WebGPU models (<50–100 MB), download UI. No large weights.
- Native plugin (Capacitor) / utility process addon (Electron): audio capture, VAD, ASR, TTS, LM/LLM, model store on the native filesystem, download manager, thermal/memory monitors, a single priority inference queue; streaming results to the UI as events.
- Sidecars (desktop only, optional): MLX server on macOS, Foundry Local on Windows, user-installed Ollama / LM Studio via localhost OpenAI-compatible API as an "external provider" setting.

Capability tiers (assigned by a start-up probe: RAM, free storage, SoC/GPU class, OS version, measured micro-benchmark tok/s, thermal state; re-evaluated on memory/thermal warnings)

| Tier | Contents | Approx. resident memory | Device classes |
|---|---|---|---|
| 0 | n-gram/statistical prediction, OS TTS (AVSpeechSynthesizer / Android TTS / SAPI), optional OS ASR; nothing to download | <100 MB | Any device; 4 GB Android tablets (Snapdragon 6, Dimensity 6xxx/7xxx), old iPads (A12–A14), low-end Windows laptops; also the fallback when thermally throttled or on low battery |
| 1 | VAD + small streaming ASR + sub-300M LM (4-bit) + small neural TTS | ~0.5–1 GB | 4–6 GB Android mid-range (Snapdragon 7, Dimensity 8xxx, Exynos), iPad A14–A16 / 4–6 GB iPhones, 8 GB Windows laptops without dGPU |
| 2 | Tier 1 + 1B-class LLM (4-bit, ~0.7–1 GB) loaded on demand; or OS model (Foundation Models / Gemini Nano) where eligible | ~1.5–2.5 GB | 8 GB Android (Snapdragon 7+/8, Dimensity 8300/9xxx), iPhone 15 Pro/16/17 and iPads with 8 GB, 8 GB Apple-silicon Mac, 16 GB Windows laptop CPU-only, Copilot+ PCs |
| 3 | Tier 2 + 3–4B LLM (4-bit, ~2–3 GB) on demand + neural voice-cloning TTS on demand (not concurrently on 8 GB devices) | ~3.5–6 GB | 16 GB Apple-silicon Mac (comfortable), 8 GB Mac (LLM only, with unload), M-series iPad 8–16 GB, 12 GB+ flagship phones, 16 GB+ Windows with dGPU or Copilot+ NPU via Foundry Local |

Operating rules
- Default every device to the highest tier whose micro-benchmark sustains ≥ ~10 tok/s for the predictor path and whose memory probe leaves headroom; let the user override downward.
- Demote one tier on `thermalState ≥ serious` (Apple) / Android thermal status severe, or on a memory warning; restore after cool-down.
- One GGUF/ONNX artefact per model across all platforms; optional platform-specific variants (MLX, LiteRT-LM `.litertlm`) only for tier 2–3 accelerators.
- Treat web-view WebGPU as an optimisation on Electron only; never as the sole path on mobile.

### Gaps
- The tier memory figures and device mappings are engineering estimates extrapolated from the sparse benchmarks in section 4; they need validation on real devices (especially Snapdragon 6/7 and Dimensity tablets, A16 iPad, and non-dGPU Intel/AMD laptops), where no primary benchmarks were found.
- Maintenance risk of the young Capacitor llama.cpp plugins vs writing an in-house plugin was not quantified.
- Whether a Swift helper for Foundation Models/SpeechAnalyzer inside a notarised Electron app raises entitlement issues was not researched.
