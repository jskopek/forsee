# Small on-device language models and keystroke-level prediction (state as of November 2026)

Verification legend used throughout:
- **[P]** = read directly from a primary source in this session (only GitHub raw files were reachable).
- **[S]** = taken from a web-search extract of the cited page; the page itself could NOT be opened from this environment (huggingface.co, arxiv.org, ar5iv, aclanthology.org, keithv.com, osf.io, liquid.ai, artificialanalysis.ai, ai.google.dev, developers.googleblog.com, docs.keyboard.futo.org, jackcook.com were all blocked). Treat [S] numbers as needing a primary check before publication.
- **[S-weak]** = search extract from a secondary/aggregator/blog source of uncertain quality.

---

## 1. Which open models under ~4B parameters exist in late 2026 (size, quality, speed, licence)?

### Takeaway
The 2026 small-model field is led by Gemma 4 E2B/E4B (April 2026, now Apache 2.0), Qwen3.5 0.8B/2B/4B (March 2026, Apache 2.0) and Liquid's LFM2.5 family (230M/350M/1.2B/2.6B; custom licence with a US$10M revenue cap); under 300M the realistic general-purpose choices are Gemma 3 270M (Gemma Terms), SmolLM2-135M/360M (Apache 2.0), LFM2.5-230M/350M and Granite 4.0 Nano 350M (Apache 2.0). For a keyboard, though, the evidence in sections 2–4 says a 25–50M purpose-trained model is the right size class, and the general models matter mostly as teachers or as the sentence-level engine.

### Cited Findings

**Google Gemma**
- Gemma 4 was released 2 April 2026 under Apache 2.0, replacing the custom Gemma Terms of Use that applied to Gemma 3 and earlier [S] — [GIGAZINE](https://gigazine.net/gsc_news/en/20260403-google-released-gemma-4/); [Google blog](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/); [HF model card E2B](https://huggingface.co/google/gemma-4-E2B)
- Gemma 4 edge sizes are E2B (~2.3B effective parameters) and E4B (~4.5B effective); larger sizes are 26B MoE and 31B, and the LiteRT-LM README also references a "Gemma 4 12B" laptop model [S for sizes, P for 12B mention] — [Codersera guide](https://codersera.com/blog/gemma-4-complete-guide-2026/); [LiteRT-LM README](https://github.com/google-ai-edge/LiteRT-LM)
- Gemma 4 E2B/E4B context window is reported inconsistently: 128K (Wikipedia, guides) vs "up to 256K" (HF E2B page extract) [S, conflicting] — [Wikipedia](https://en.wikipedia.org/wiki/Gemma_(language_model)); contradicted by [HF gemma-4-E2B](https://huggingface.co/google/gemma-4-E2B)
- Gemma 4 E2B speed: Google reports 52 tok/s decode on Android GPU (OpenCL) and 56 tok/s on iOS (Metal) without multi-token prediction (MTP) [S] — [Google Developers Blog, "Blazing fast on-device GenAI with LiteRT-LM"](https://developers.googleblog.com/blazing-fast-on-device-genai-with-litert-lm/)
- Gemma 4 E2B on a MacBook M4 Pro (24 GB), int4, LiteRT-LM Metal GPU: 84.2 tok/s baseline, 144.3 tok/s with MTP; LiteRT-LM CPU ~37 tok/s; HF transformers+MPS bf16 21.9 tok/s. Google's own figure is 160 tok/s on an M4 Max [P, community benchmark repo] — [iprajax/gemma4-mtp](https://github.com/iprajax/gemma4-mtp)
- Gemma 4 E2B on Raspberry Pi 5 via LiteRT-LM: 133 tok/s prefill, 7.6 tok/s decode [S-weak] — [dev.to](https://dev.to/samdude/gemma-4-on-android-tricks-for-faster-on-device-inference-3kj5); a Jetson Thor CPU run showed peak RAM 2.54 GB for E2B [S] — [NVIDIA forum](https://forums.developer.nvidia.com/t/benchmark-litert-lm-vs-llama-cpp-server-gemma-4-e2b-on-nvidia-jetson-thor/380349)
- LiteRT-LM (Google's runtime) lists "Accelerated Logit Masking: faster constrained decoding on GPUs" and a Web SDK (`@litert-lm/core`) defaulting to GPU — relevant to trie-constrained decoding in a web UI [P] — [LiteRT-LM README](https://github.com/google-ai-edge/LiteRT-LM)
- Gemma 3 270M (Aug 2025): 170M embedding parameters + 100M transformer parameters; INT4 model used 0.75% of a Pixel 9 Pro battery for 25 conversations (Google internal test, unverified, conversation length unspecified); licence = Gemma Terms of Use (commercial use allowed, not OSI open source) [S] — [The Register](https://www.theregister.com/2025/08/15/little_llm_on_the_ram/); [VentureBeat](https://venturebeat.com/ai/google-unveils-ultra-small-and-efficient-open-source-ai-model-gemma-3-270m-that-can-run-on-smartphones)
- Gemma 3 270M and 1B have a 32K context; 140+ languages claimed for the family [S] — [Gemma 3 model card mirror](https://gemma.ai/models/gemma-3/); a contradictory 128K figure for 270M appears in [Raschka's architecture gallery](https://sebastianraschka.com/llm-architecture-gallery/)
- Gemma 3 270M size: ~125 MB INT4, ~241 MB Q8, ~540 MB FP16 [S-weak] — [localaimaster.com](https://localaimaster.com/models/gemma-3-270m)
- Gemma 3n E2B/E4B (2025): raw 5B/8B parameters, run with ~2 GB/~3 GB memory footprint via per-layer embeddings; custom Gemma licence. Anecdotal Pixel 7 Pro speed: 35.6 tok/s prefill, 7.1 tok/s decode [S; speed is an HN comment] — [Google developer guide](https://developers.googleblog.com/en/introducing-gemma-3n-developer-guide/); [HN thread](https://news.ycombinator.com/item?id=44044199)

**Alibaba Qwen**
- Qwen3 (2025) dense sizes: 0.6B, 1.7B, 4B, 8B, 14B, 32B; "100+ languages" [P] — [QwenLM/Qwen3 README](https://github.com/QwenLM/Qwen3)
- Qwen3-0.6B: 32,768-token context, Apache 2.0 [S] — [Raschka gallery](https://sebastianraschka.com/llm-architecture-gallery/); [apxml](https://apxml.com/models/qwen3-0-6b)
- Qwen3.5 small series (0.8B, 2B, 4B, 9B) released ~2 March 2026, Apache 2.0, 262K native context, 248K vocabulary covering 201 languages, native vision input; 0.8B Q8_0 GGUF ≈ 812 MB plus ~207 MB vision projector [S] — [Artificial Analysis](https://artificialanalysis.ai/articles/qwen3-5-small-models); [Ollama qwen3.5:0.8b](https://ollama.com/library/qwen3.5:0.8b); [VentureBeat](https://venturebeat.com/technology/alibabas-small-open-source-qwen3-5-9b-beats-openais-gpt-oss-120b-and-can-run)
- Qwen3.5 speed claims are inconsistent blog reports: 0.8B ">22 tok/s on an iPhone"; 2B 30–50 tok/s on flagships; ~8 tok/s for 2B on budget Android [S-weak] — [covebase](https://covebase.pages.dev/en/on-device-ai/models/qwen); [ertas.ai](https://www.ertas.ai/blog/best-models-on-device-mobile-ai-2026)
- Qwen3 0.6B (Q6_K, llama.cpp) on a 4 GB Galaxy A05s (Snapdragon 680, budget): 14.8 tok/s, 11.0 tok/s at 768 tokens of context [S, single developer] — [neykosa.com benchmarks](https://neykosa.com/benchmarks/)

**Liquid AI LFM2 / LFM2.5**
- Licence: "LFM Open License v1.0" — Apache-2.0-based text plus a cap: free commercial use only for entities under US$10M annual revenue; above that a commercial licence is required; the cap also applies to fine-tunes/derivatives; not OSI open source. A LICENSE file naming it exists for LFM2-350M; LFM2.5-230M and LFM2.5-8B-A1B are listed under it [S] — [Liquid licence page](https://www.liquid.ai/lfm-license); [Liquid docs licence guide](https://docs.liquid.ai/lfm/help/model-license); [HF LFM2-350M LICENSE](https://huggingface.co/LiquidAI/LFM2-350M/blob/main/LICENSE); [HF discussion "isn't free license"](https://huggingface.co/LiquidAI/LFM2-2.6B-Exp-GGUF/discussions/3)
- LFM2.5-350M ("No Size Left Behind"): trained on 28T tokens; on-device, Cactus measured INT8, CPU-only: iPhone 17 Pro ≈ 797 tok/s prefill and 140 tok/s decode; Raspberry Pi ≈ 30 tok/s decode [S] — [Liquid blog](https://www.liquid.ai/blog/lfm2-5-350m-no-size-left-behind); [Cactus blog](https://cactuscompute.com/blog/lfm2-5-350m)
- LFM2.5 family members seen in Liquid's own cookbook: LFM2-350M, LFM2-1.2B, LFM2-2.6B, LFM2.5-1.2B (incl. Thinking, JP), with WebGPU/Transformers.js browser demos for LFM2.5-1.2B [P] — [Liquid4All/cookbook](https://github.com/Liquid4All/cookbook)
- LFM2.5-8B-A1B (MoE, ~1B active) reported ≈30 tok/s on a phone under 6 GB; LFM2.5-2.6B best instruction-following measured on iPhone (59% IFBench) [S] — [Artificial Analysis phone inference article](https://artificialanalysis.ai/articles/mobile-phone-intelligence-inference)

**Hugging Face SmolLM**
- SmolLM2 comes in 135M, 360M and 1.7B; SmolLM2-135M has 134.5M parameters, Apache 2.0, released 2024-11 [P via typeling plan table; repo README] — [typeling model-plan](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md); [huggingface/smollm](https://github.com/huggingface/smollm)
- SmolLM3-3B (July 2025): Apache 2.0; trained at 64K context, up to 128K with YaRN; 6 natively supported languages (EN, FR, ES, DE, IT, PT) [S] — [HF SmolLM3-3B](https://huggingface.co/HuggingFaceTB/SmolLM3-3B)

**Microsoft**
- Phi-4-mini-flash-reasoning: 3.8B, MIT licence, 64K context, SambaY decoder-hybrid-decoder architecture [S] — [HF model card](https://huggingface.co/microsoft/Phi-4-mini-flash-reasoning)
- Phi Silica (Windows-bundled SLM for Copilot+ NPUs): 3.3B parameters at announcement; time to first token 230 ms for short prompts, up to 20 tok/s, 2K context (4K "coming") per Microsoft's Dec 2024 blog; 650 tok/s NPU prompt processing; accessed only through Windows AI APIs in the Windows App SDK (weights are not distributed; not an open model) [S] — [Windows blog](https://blogs.windows.com/windowsexperience/2024/12/06/phi-silica-small-but-mighty-on-device-slm/); [VentureBeat](https://venturebeat.com/ai/microsoft-introduces-phi-silica-a-3-3b-parameter-model-made-for-copilot-pc-npus)
- BitNet b1.58 2B4T: 2.4B parameters, ternary weights, trained on 4T tokens; bitnet.cpp is MIT; CPU inference only gives the gains (not via transformers); NPU support "coming next" [P] — [microsoft/BitNet README](https://github.com/microsoft/BitNet)
- BitNet b1.58 2B4T vs peers (technical report table): 0.4 GB non-embedding memory vs 1.4 GB Gemma-3 1B and 2.6 GB Qwen2.5 1.5B; CPU decoding latency 29 ms/token vs 41 ms (Gemma-3 1B) and 65 ms (Qwen2.5 1.5B); estimated energy 0.028 J vs 0.186 J / 0.347 J per token [S] — [arXiv 2504.12285](https://arxiv.org/pdf/2504.12285)
- BitNet also ships 1-bit embedding models at 270M and 0.6B (2026) [P] — [microsoft/BitNet README](https://github.com/microsoft/BitNet)

**Meta**
- Llama 3.2 1B/3B on a OnePlus 12 with ExecuTorch: 1B bf16 19.4 tok/s vs SpinQuant 53.4 tok/s (50.2 tok/s decode / 260 tok/s prefill in another Meta post); 3B 7.8 vs 23.0 tok/s; RSS 1,921 MiB (1B SpinQuant) and 3,726 MiB (3B SpinQuant). Licence: Llama 3.2 Community License + Acceptable Use Policy (custom, not OSI) [S; 2024 figures] — [ExecuTorch PR 6434](https://github.com/pytorch/executorch/pull/6434/files); [Meta blog](https://ai.meta.com/blog/meta-llama-quantized-lightweight-models/)
- MobileLLM (ICML 2024): 125M/350M/600M/1B/1.5B; 125M/350M beat prior SoTA at those sizes by 2.7%/4.3% on zero-shot commonsense tasks [P] — [facebookresearch/MobileLLM](https://github.com/facebookresearch/MobileLLM)
- MobileLLM-R1 (Sept 2025, ICLR 2026): 140M (15 layers, dim 576), 359M, 949M; 128k vocab; base models 4k context, final 32k; R1-950M matches/surpasses Qwen3-0.6B on MATH/GSM8K/MMLU/LiveCodeBench with ~2T pretraining tokens; mid-training uses KL distillation from Llama-3.1-8B-Instruct; MobileLLM-R1.5 released Nov 2025 [P] — [facebookresearch/MobileLLM-R1](https://github.com/facebookresearch/MobileLLM-R1)
- MobileLLM-Pro (1B, Oct 2025, Meta Reality Labs): licence `fair-noncommercial-research-license` (FAIR NC), gated; ships int4 CPU/accelerator checkpoints. The original MobileLLM line is also FAIR NC [S] — [HF MobileLLM-Pro README](https://huggingface.co/facebook/MobileLLM-Pro/blob/main/README.md)

**IBM Granite**
- Granite 4.0 language models are all Apache 2.0; initial sizes micro/tiny/small, dense, dense-hybrid and MoE-hybrid; base (pretrain-only) and instruct checkpoints both published [P] — [ibm-granite/granite-4.0-language-models](https://github.com/ibm-granite/granite-4.0-language-models)
- Granite 4.0 Nano (28 Oct 2025): ~350M and ~1.5B hybrid-SSM models ("H") plus plain-transformer 350M / ~1.6B variants for runtimes like llama.cpp that lack hybrid support; Apache 2.0; MMLU 5-shot ≈36 (350M) and ≈59 (1B); IFEval 78.5 for H-1B vs 73.1 Qwen3-1.7B vs 59.3 Gemma 3 1B (IBM's numbers) [S] — [HF blog](https://huggingface.co/blog/ibm-granite/granite-4-nano); [SiliconANGLE](https://siliconangle.com/2025/10/29/ibm-releases-small-open-source-granite-4-models-mobile-devices-browsers/)

**Sub-100M general-purpose bases (2026 community models; quality claims unverified)**
- A Nov 2026 survey inside the Typeling project lists Apache-2.0 base models under 100M: SupraLabs Supra2-Medium-Base (25.4M, Qwen3 architecture, 7 layers, hidden 512, 16,384-token byte-level BPE, context 1,024, trained on 20B FineWeb-Edu tokens, released 2026-08), Supra-50M-Base (51.8M, Llama architecture, 2026-05), Supra2-100M-Base (100.7M, 2026-07), BarunLM-35M, Isabel-50M; older Pythia-14M/31M used as baselines [P for the survey; underlying HF cards not checked] — [typeling model-plan](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md)

**Byte/character-level models**
- Vertanen's TextSlinger library supports three back-ends: KenLM n-gram (12-gram character models), subword LLMs via Hugging Face, and byte-tokenised LLMs via the `uniformers` library (ByGPT5 family) [P] — [kdv123/textpredict README](https://github.com/kdv123/textpredict)
- In Gaines & Vertanen (EMNLP Findings 2025) the subword-LLM search algorithm gave lower per-character perplexity than a byte-level LLM, though it took almost 7× longer per prediction (byte-level ≈12 ms) [S] — [arXiv 2501.10582](https://arxiv.org/html/2501.10582)

**Third-party cross-model observations**
- Artificial Analysis (2026) notes that on phones both speed and token usage matter: Qwen3.5 9B is "highly intelligent" but spends far more output tokens than Gemma 4 E4B [S] — [Artificial Analysis](https://artificialanalysis.ai/articles/mobile-phone-intelligence-inference)
- Liquid AI runs an on-device benchmark leaderboard ("pipette") [S, not readable here] — [pipette.liquid.ai/leaderboard](https://pipette.liquid.ai/leaderboard)

### Licence summary (weights) for an MIT app shipped through app stores
| Model | Licence | Flag |
|---|---|---|
| Gemma 4 (E2B/E4B) | Apache 2.0 [S] | OK |
| Gemma 3 / 3n / 3 270M | Gemma Terms of Use [S] | custom; commercial OK with use-policy pass-through |
| Qwen3 / Qwen3.5 small | Apache 2.0 [S] | OK |
| SmolLM2 / SmolLM3 | Apache 2.0 [P/S] | OK |
| Granite 4.0 incl. Nano | Apache 2.0 [P] | OK |
| Phi-4-mini(-flash) | MIT [S] | OK |
| BitNet b1.58 2B4T | MIT [P for repo; S for weights] | OK |
| LFM2 / LFM2.5 | LFM Open License v1.0 [S] | custom; US$10M revenue cap, applies to derivatives — problematic for redistribution in an MIT project because downstream users inherit the cap |
| Llama 3.2 | Llama 3.2 Community License + AUP [S] | custom |
| MobileLLM / MobileLLM-Pro | FAIR NC [S] | NON-COMMERCIAL — do not ship |
| Phi Silica | OS component, no weights [S] | Windows Copilot+ only |
| Typeling-25M, Supra bases | Apache 2.0 [P] | OK |
| FUTO English keyboard LM | FUTO Source First License 1.1 applies to the app repo [P via community doc] | not OSI; model licence itself unverified |

Sources for the table are the per-model citations above.

### Inferences
- For a keyboard LM that will be redistributed inside an MIT-licensed app, the clean choices are Apache/MIT weights: Gemma 4, Qwen3/3.5, SmolLM2/3, Granite 4, Phi-4-mini, BitNet, and the community 25–50M bases. LFM2.5-350M is technically the fastest sub-1B model in published phone numbers but its revenue-capped licence passes an obligation on to every downstream distributor.
- Vision projectors and 248K-token vocabularies (Qwen3.5) are dead weight for keystroke prediction; embedding tables dominate the smallest models (170M of Gemma 3 270M's parameters are embeddings), which is an argument for a small dedicated vocabulary (15–16K) as FUTO, Apple and Typeling use.

### Gaps
- No evidence found of a "Qwen 3.6" small release; Qwen3.5 small models (March 2026) are the latest I could confirm, and only from secondary sources.
- MobileLLM-R1 / R1.5 weight licence not confirmed (repo README is silent in the lines read; earlier MobileLLM lines are FAIR NC).
- No verified quantised file sizes for Gemma 4 E2B/E4B, Qwen3-0.6B GGUF, or LFM2.5-350M; no verified RAM figures for iPad/Android tablets specifically.
- DeepSeek-distilled small models: only found as a comparison point (MobileLLM-R1.5-950M beats DeepSeek-R1-Distill-Qwen-1.5B per Meta's README); no keyboard relevance found.
- No published tokens/s for any sub-1B model on a Copilot+ NPU or on a no-dGPU Intel/AMD laptop from a primary source, other than BitNet's 29 ms/token CPU figure (hardware not stated in the extract).
- ByT5 and CANINE: no 2025–2026 on-device results found; only the ByGPT5-style byte model in Vertanen's work.

---

## 2. Realistic per-keystroke latency (one forward pass with a warm KV cache), and how a 25–300M model compares with an n-gram

### Takeaway
Published numbers put a purpose-built 25M model at roughly 0.4 ms per incremental token on a laptop CPU with llama.cpp and 20–35 ms per complete keystroke query (beam search over words, typo repair, in unoptimised PyTorch); general 350M–2B models cost roughly 7–70 ms per token on phones. Neural models beat n-grams by about 5–11 points of keystroke savings on conversational text, at 100–1000× the compute per query — which is still inside a 50–100 ms budget.

### Cited Findings
- Typeling-25M (25.4M parameters, GGUF Q8_0 = 27.55 MB) with llama.cpp on a laptop CPU, 4 threads: 11,900 tok/s prompt processing (pp256) and 2,800 tok/s single-token decode [P] — [typeling model-plan §15](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md)
- Typeling-25M full keystroke query (constrained beam search, beam 8, typo repair, n-gram fusion; PyTorch float32, 4 CPU threads): mean 23–25 ms on chat text (p95 39–45 ms, p99 51–56 ms), 32.8 ms on long documents (p95 63 ms, p99 82 ms). Most time is copying the KV cache per hypothesis in PyTorch; cost grows with context (15 ms at 30 tokens of context) [P] — [typeling model-plan §13–14](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md)
- Typeling's design target: p95 ≤ 50 ms, p99 ≤ 100 ms per suggestion on a laptop CPU, "100 ms is about the limit of what feels" immediate [P] — [typeling model-plan §6](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md)
- Typeling's n-gram kernel (pruned 5 MB modified-Kneser-Ney trigram, 60k vocabulary, pure Python): 41–115 µs per query, p99 < 0.7 ms, loads in < 50 ms [P] — [typeling README](https://github.com/scarletkc/typeling)
- Keystroke savings, Typeling-25M vs n-gram on sealed test split (ghost-text KSR / KSR with a 3-candidate bar): chat 43.1% / 58.0% vs 31.6% / 48.8% (5 MB n-gram) and 34.1% / 50.6% (unpruned 23 MB n-gram); casual IRC 29.8% / 46.8% vs 22.7% / 38.9%; writing 32.4% / 49.9% vs 22.3% / 40.6% [P] — [typeling README](https://github.com/scarletkc/typeling)
- With every word of 3+ letters mistyped, chat KSR@3 falls 49.6% → 40.5% for the n-gram but only 59.4% → 55.7% for Typeling-25M; intended word is in the bar for 94.5% vs 71.0% of mistyped words [P] — [typeling README](https://github.com/scarletkc/typeling)
- Zero-shot (no domain training) small LMs vs n-gram, chat KSR: Pythia-14M 28.5%, Pythia-31M 31.2%, Supra2-Medium 25.4M 33.5%, Supra-50M 35.6%, unpruned n-gram 31.9%; the n-gram wins on in-domain synthetic dialogue (SODA) it was trained on [P] — [typeling model-plan §12](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md)
- Simulated 4-bit quantisation of a 50M model costs 0.4–1.1 KSR points and raises per-word perplexity 13–20% [P] — [typeling model-plan §12](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md)
- Gaines & Vertanen (EMNLP Findings 2025): best domain-adapted LLM (OPT-350M-based) gave +5.5% absolute keystroke savings over an AAC n-gram model in a simulated on-screen keyboard; LLM search-algorithm inference was ~55–120 ms per character prediction vs ~0.1 ms for the n-gram; domain adaptation cut opt-350m dev per-character perplexity from 2.30 to 2.07 [S] — [arXiv 2501.10582](https://arxiv.org/pdf/2501.10582); [ACL Anthology](https://aclanthology.org/2025.findings-emnlp.826/)
- Vertanen's 2011 AAC work: best model ensemble increased keystroke savings by 9.6%; trained with the crowdsourced AACText corpus (~6,000 fictional AAC-like sentences via Mechanical Turk) [S; 2011] — ["The Imagination of Crowds"](https://www.researchgate.net/publication/221012641_The_Imagination_of_Crowds_Conversational_AAC_Language_Modeling_using_Crowdsourcing_and_Large_Data_Sources)
- Lexo Keyboard (Android, 2026): first shipped Qwen2.5-0.5B-Instruct Q8_0 (531 MB GGUF, llama.cpp); moving to the 1.5B model improved next-word top-1 only 19.0% → 20.1% and top-5 39.0% → 39.4% at ~2.4× decode cost; author concludes the task is capped by the predictability of short informal text, not model size; now ships a fine-tuned SmolLM2-360M with a word-scoring head, one model per language, CPU via llama.cpp [S; figures also quoted P in typeling plan] — [Lexo write-up](https://lexokeyboard.app/writeups/on-device-llm-keyboard/)
- Per-token decode speeds for general models (invert to get ms per forward pass): LFM2.5-350M INT8 on iPhone 17 Pro CPU 140 tok/s [S] — [Cactus](https://cactuscompute.com/blog/lfm2-5-350m); Gemma 4 E2B 52 tok/s Android GPU / 56 tok/s iOS GPU [S] — [Google Developers Blog](https://developers.googleblog.com/blazing-fast-on-device-genai-with-litert-lm/); Llama 3.2 1B SpinQuant ~50 tok/s on OnePlus 12 [S] — [ExecuTorch PR](https://github.com/pytorch/executorch/pull/6434/files); Qwen3-0.6B Q6_K 14.8 tok/s on Snapdragon 680 [S] — [neykosa](https://neykosa.com/benchmarks/); BitNet 2B 29 ms/token on CPU [S] — [arXiv 2504.12285](https://arxiv.org/pdf/2504.12285); Gemma 4 E2B ~37 tok/s on M4 Pro CPU, 84 tok/s Metal [P] — [gemma4-mtp](https://github.com/iprajax/gemma4-mtp)
- Phi Silica on Copilot+ NPU: 230 ms time-to-first-token for short prompts, ≤20 tok/s [S] — [Windows blog](https://blogs.windows.com/windowsexperience/2024/12/06/phi-silica-small-but-mighty-on-device-slm/)
- 2017–2018 baselines: an on-device RNN word predictor was 7.4 MB with 6.47 ms average prediction time [S; 2017] — [arXiv 1707.01662](https://arxiv.org/pdf/1707.01662); Gboard's federated CIFG-LSTM is ~1.4M parameters, 1.4 MB quantised, 10k-word vocabulary, beating a Katz 5-gram with 1.25M n-grams [S; 2018] — [arXiv 1811.03604](https://arxiv.org/pdf/1811.03604v2)
- Cloud LLM abbreviation systems for gaze typing had 240–660 ms latency (as cited by a later paper) [S] — [arXiv 2507.19736](https://arxiv.org/pdf/2507.19736)

### Inferences (derived, not measured)
- Single-token forward-pass estimates from the tok/s above: 25M model on laptop CPU ≈ 0.36 ms; LFM2.5-350M on iPhone 17 Pro CPU ≈ 7 ms; Gemma 4 E2B on flagship phone GPU ≈ 18–19 ms, on M4 Pro GPU ≈ 12 ms, M4 Pro CPU ≈ 27 ms; Llama 3.2 1B on a 2024 flagship ≈ 20 ms; Qwen3-0.6B on a budget Snapdragon 680 ≈ 68 ms.
- A next-letter distribution or top-3 word list needs not one but roughly 10–100 forward passes (beam × tokens per word), unless batched. So: a 25–50M model can do exact per-keystroke search on every device class incl. a mid-range Android tablet (estimate: a few ms per pass on a mid-range ARM CPU → tens of ms per keystroke); a 270–360M model is feasible per keystroke on Apple silicon and flagship phones but marginal on mid-range Android; 1B+ models should be reserved for word/sentence-level calls made after a pause, not for every keystroke.
- In an eye-tracking keyboard, dwell times are 300–1000 ms, so a 50–100 ms prediction budget per keystroke is comfortable; the stricter constraint is that dwell-time shortening must be decided before gaze lands on the next key, which the n-gram (µs) can cover instantly while the neural result arrives asynchronously (Typeling plans exactly this: n-gram first, LM ranking replaces it when it arrives).

### Gaps
- No primary-source time-to-first-token / per-token measurement for sub-1B models on a mid-range iPad or mid-range Android tablet was found; the closest are a budget phone (Snapdragon 680) and flagships.
- The hardware used for Gaines & Vertanen's 55–120 ms figure could not be read (paper blocked).
- No measurement found of a 25–50M model on mobile ARM CPUs or via WebGPU/WASM inside Electron/Capacitor webviews.
- No head-to-head of a 100–300M general model vs 12-gram character model on an AAC test set beyond the single +5.5% KS figure.

---

## 3. Techniques for getting character-level and word-level predictions from subword LLMs; prior art (Vertanen, Google, Apple, FUTO, SwiftKey, HeliBoard); noisy-channel decoding

### Takeaway
The proven recipe is: back off to the start of the current word, run a prefix-constrained beam search over tokens, and sum probabilities of all hypotheses by the character (or whole word) that follows the typed context; Vertanen's group has open code for exactly this (TextSlinger, used in BciPy), and FUTO, Apple, Lexo and Typeling show production variants built on 25–40M-parameter models with small custom vocabularies and special keystroke tokens.

### Cited Findings

**Vertanen group (Michigan Tech)**
- Paper: Gaines & Vertanen, "Adapting Large Language Models for Character-based Augmentative and Alternative Communication", Findings of EMNLP 2025, pp. 15273–15291; arXiv 2501.10582 (v3, 2 Oct 2025); code, datasets, classifier and best models on OSF https://osf.io/ajm7t/ [S] — [ACL Anthology](https://aclanthology.org/2025.findings-emnlp.826/); [keithv.com page](https://keithv.com/pub/aacllm/)
- Claim: their search algorithm over a subword LLM is more accurate than (a) adding a character classification layer to the LLM, (b) a byte-level LLM, and (c) an n-gram model [S] — [arXiv abstract](https://arxiv.org/abs/2501.10582)
- The algorithm, as documented in BciPy: remove all subword tokens of the current partially typed word from the context (removing more tokens gives the model more flexibility at higher cost); ask the model for next-token likelihoods; keep only tokens consistent with the typed characters; track a limited number of hypotheses (beam width) and extend each until it passes the end of the typed context; store each finished hypothesis's likelihood under the character that directly follows the context; sum per character and normalise to get the next-character distribution [P] — [BciPy language README](https://github.com/CAMBI-tech/BciPy/blob/main/bcipy/language/README.md)
- Worked example of why this is needed: `peanut_butter_and_jel` tokenises as `['pe','anut','_butter','_and','_j','el']`, so the final partial tokens must be re-opened [P] — [BciPy language README](https://github.com/CAMBI-tech/BciPy/blob/main/bcipy/language/README.md)
- Open implementation: TextSlinger (`textslinger` on PyPI; repo kdv123/textpredict) — predicts the next-character distribution and the most likely next words; back-ends: KenLM 12-gram n-grams, subword LLMs, byte LLMs; NSF-funded (IIS-1909089, IIS-2402876) [P] — [kdv123/textpredict](https://github.com/kdv123/textpredict)
- BciPy's CausalLanguageModelAdapter has been tested with gpt2, facebook/opt and distilgpt2 families, including the domain-adapted model `figmtu/opt-350m-aac`; a MixtureLanguageModelAdapter interpolates models (e.g. n-gram + causal LM) with fixed weights [P] — [BciPy language README](https://github.com/CAMBI-tech/BciPy/blob/main/bcipy/language/README.md)
- AAC-domain character n-gram models (e.g. `lm_dec19_char_large_12gram.kenlm`) are distributed at imagineville.org/software/lm/dec19_char/ [P for the pointer; site not opened] — [BciPy language README](https://github.com/CAMBI-tech/BciPy/blob/main/bcipy/language/README.md)
- Domain adaptation data: sentences from web and movie-subtitle corpora, selected by a classifier rating similarity to spoken/written AAC-style communication; fine-tuning also used Forum (Vertanen & Kristensson 2021), BOLT (Song et al. 2014) and DailyDialog (Li et al. 2017) [S] — [arXiv 2501.10582](https://arxiv.org/html/2501.10582)
- The same paper builds a recogniser for noisy abbreviated input where users drop spaces and mid-word vowels [S] — [ACL Anthology abstract](https://aclanthology.org/2025.findings-emnlp.826/)
- Older n-gram tooling: TextPredictorPython — WordPredictor (prefix + left context → probable words, using a vocabulary trie) and CharacterPredictor over KenLM, with support for adding user vocabularies [P] — [kdv123/TextPredictorPython](https://github.com/kdv123/TextPredictorPython); PPM language model code [P listing] — [kdv123/PPMLM](https://github.com/kdv123/PPMLM)

**Google (AAC and Gboard)**
- SpeakFaster (Cai et al., Nature Communications 15, Nov 2024, DOI 10.1038/s41467-024-53873-3): LLM UI for highly abbreviated entry; 57% more motor-action savings than traditional predictive keyboards in offline simulation; text-entry rate 29–60% above baseline for two eye-gaze users with ALS; the model is a fine-tuned 64B-parameter LaMDA expanding word-initial-letter abbreviations, with optional spelled-out keywords [S] — [PMC full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC11530652); [Google Research](https://research.google/pubs/using-large-language-models-to-accelerate-communication-for-eye-gaze-typing-users-with-als/)
- Cai et al., NAACL 2022, "Context-Aware Abbreviation Expansion Using Large Language Models": a 64B LLM exactly expands >70% of phrases with abbreviation length ≤10 → keystroke saving up to ~77% on exact expansions; one turn of conversational context more than doubles accuracy; fine-tuning on noisy data improves typo robustness [S] — [arXiv 2205.03767](https://arxiv.org/pdf/2205.03767)
- Team Gleason's SpeakFaster GitHub mission: double eye-gaze communication rate from an average 12 wpm to 24 wpm; planned experiments include language models that "apply the probability of letter selection to keyboard signal" [P] — [TeamGleason/SpeakFaster](https://github.com/TeamGleason/SpeakFaster)
- "Neural Search Space in Gboard Decoder" (Zhang et al., EMNLP 2024 Industry, arXiv 2410.15575): replaces the n-gram language FST in Gboard's decoder with a neural LM whose context-conditioned outputs are converted into the language transducer at runtime; Words Modified Ratio dropped ~0.26–1.19% across locales with "acceptable" latency increase [S] — [arXiv 2410.15575](https://arxiv.org/pdf/2410.15575); [ACL Anthology](https://aclanthology.org/2024.emnlp-industry.93.pdf)
- Gboard next-word LMs are trained with federated learning + differential privacy (DP-FTRL); all Gboard NWP neural LMs have DP guarantees (20+ models) [S; 2023] — [arXiv 2305.18465](https://arxiv.org/pdf/2305.18465)
- MozoLM: Google Research's open-source language-model microservice for AAC text entry (Roark & Gutkin, SLPAT 2022) [P] — [google-research/mozolm](https://github.com/google-research/mozolm)

**Apple**
- iOS 17 (2023) introduced a transformer LM for autocorrect and inline predictions, run on every key press; Jack Cook's reverse-engineering estimated a GPT-2-style model of ~34M parameters, hidden size 512, ~15,000-token vocabulary; this is an outside estimate, not an Apple disclosure; initially English, Spanish, French [S; 2023] — [Simon Willison summary](https://simonwillison.net/2024/Jun/3/transformer-powered-predictive-text/); [Michael Tsai](https://mjtsai.com/blog/2023/09/18/apples-new-transformer-powered-predictive-text-model/)
- Later details: iOS 18 added a multilingual keyboard; claims about iOS 26/27 language counts and an Apple-Intelligence keyboard come from aggregator sites and are unverified [S-weak] — [Gadget Hacks](https://apple.gadgethacks.com/news/ios-27-keyboard-improvements-explained-3-years-of-updates/)

**FUTO Keyboard (Android, open-ish)**
- App source is under the FUTO Source First License 1.1 (not OSI); it runs two engines in parallel and merges them: an AOSP dictionary+bigram engine (~28 languages) and a "Transformer LM" (English only officially) on llama.cpp in GGUF [P via community research doc quoting FUTO docs] — [itzune/futo-basque RESEARCH.md](https://github.com/itzune/futo-basque/blob/main/RESEARCH.md)
- Architecture (verified by that author against the reference model): vanilla Llama config, ~36M parameters, vocab 15,008 (SentencePiece unigram with 300 reserved user-defined symbols + byte fallback), hidden 512, intermediate 1024, 8 layers, 8 heads, untied embeddings, 2048-token context; shipped file `ml4_q6_k` (Q6_K quantised) [P, community doc] — [futo-basque RESEARCH.md](https://github.com/itzune/futo-basque/blob/main/RESEARCH.md)
- Keystroke prompt format: autocorrect is done by feeding each typed letter as a dedicated `<CHAR_X>` token wrapped as `<XBU><CHAR_T><CHAR_E><CHAR_H><XBC>The <XEC>`; feeding the literal typo text instead gives ~0% accuracy; the C++ mixes `<CHAR_*>` embeddings (feature flag `char_embed_mixing_v1`) so that uncertain keypresses can be represented as a weighted mixture of key embeddings [P, community doc] — [futo-basque RESEARCH.md](https://github.com/itzune/futo-basque/blob/main/RESEARCH.md)
- API surface: `PredictNextWord(context, banned_words)` and `PredictCorrection(context, mixes, swipe_mode, capitals, banned_words)`; Kotlin merges with dictionary suggestions using a "Transformer LM strength" slider, up to 128 candidates [P, community doc] — [futo-basque RESEARCH.md](https://github.com/itzune/futo-basque/blob/main/RESEARCH.md)
- On-device LoRA personalisation exists (llama.cpp LoRA trainer, r=16, merged GGUF written afterwards) but FUTO's wiki says it is disabled by default as possibly unstable/ineffective [P community doc; S for wiki] — [futo-basque RESEARCH.md](https://github.com/itzune/futo-basque/blob/main/RESEARCH.md); [FUTO GitLab wiki](https://gitlab.futo.org/keyboard/keyboard-wiki/-/wikis/FUTO-Keyboard/diff?version_id=1dfd9e50b673c2c695fc844a4fd1e6f16b71000d)
- Community models in the same format: German ~33M [P] — [Gabriel-Graf/FUTO-Transformer-DE](https://github.com/Gabriel-Graf/FUTO-Transformer-DE); Greek ~36.1M with 39.33% next-word top-1 [S] — [HF stamchry/greek-keyboard-lm](https://huggingface.co/stamchry/greek-keyboard-lm); Brazilian Portuguese ~42M [S] — [HF barddoo/futo-keyboard-ptbr](https://huggingface.co/barddoo/futo-keyboard-ptbr)
- FUTO's separate swipe-typing models include a ~1.5M-parameter context LM (6.25 MB fp32) [S] — [HF futo-org/futo-swipe](https://huggingface.co/futo-org/futo-swipe)

**HeliBoard**
- HeliBoard (AOSP/OpenBoard fork) uses AOSP dictionaries for suggestions and spell check; glide typing only with a closed-source library; no neural LM is mentioned [P] — [Helium314/HeliBoard README](https://github.com/Helium314/HeliBoard)

**Typeling (Apache-2.0, Nov 2026) — a complete open reference decoder**
- Decoder: a prefix phase allows only tokens consistent with the typed prefix (" k", " kn", " know"); a word phase extends with letter/contraction tokens until the model ends the word; a word's probability is the sum over its tokenisations found in the beam; search stops when no remaining hypothesis can beat the third-best word (beam 8) [P] — [typeling model-plan §6](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md)
- Trailing-space problem: with byte-level BPE the space belongs to the next token, so a context ending in a space pushes the model toward junk tokens; fixed by constraint and by "trailing-space augmentation" (re-tokenising 1% of word-initial tokens as " " + word; 1% costs ~1% perplexity) [P] — [typeling model-plan §4, §6](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md)
- Typo repair in the decoder (QWERTY keyboard error model generating alternative prefixes scored by the LM) beat a 40M-token typo fine-tuning experiment on both clean and mistyped input [P] — [typeling model-plan](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md)
- Subword pieces can form non-words ("don'tknow"), which is why fusion with a lexicon/n-gram and a hidden-word filter are applied after search [P] — [typeling model-plan §6](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md)

**Token healing / exact marginalisation literature**
- Token healing (backing up one token and constraining the next token to start with the removed characters) is a heuristic, not an exact marginalisation; a correct implementation needs a constrained beam search, and it fails when the last sub-token could merge with the previous one [S] — [ACL 2024, "Empowering Character-level Text Infilling by Eliminating Sub-Tokens"](https://aclanthology.org/2024.acl-long.179.pdf)
- A character string has many token strings; a committed token-by-token decoder can reach a state where the target is only reachable via a different earlier split [S] — [TMLS write-up](https://www.tmls.nyc/research/constrained-decoding-semantics)
- A character-level trie over a lexicon admits both canonical and non-canonical BPE splits and lets the model's logits choose (2026 preprint "Trie Automata for Constrained Decoding over Large Finite Sets"); Cognetta & Okazaki (2025) instead enforce canonical tokenisation with a finite-state transducer, arguing LMs are conditioned on the exact tokenisation [S] — [arXiv 2608.12574](https://arxiv.org/pdf/2608.12574)
- "Byte-prefix marginalisation" for cross-tokeniser distillation (2026) computes a byte-prefix marginal that provably preserves the teacher's probability mass — directly usable to distil a subword teacher into a byte/char-level student [S] — [arXiv 2607.22334](https://arxiv.org/pdf/2607.22334)

**Noisy-channel decoding of gaze/touch input**
- Standard keyboard decoding combines a spatial-model probability with an LM probability by Bayes' rule; CHI 2025 "LLM Powered Text Entry Decoding and Flexible Typing on Smartphones" fine-tunes FLAN-T5 as a unified tap+gesture decoder [S] — [ACM DL](https://dl.acm.org/doi/10.1145/3706598.3714314)
- KeySense (2026) decodes noisy ten-finger multi-touch with a T5-style seq2seq model and notes that domain-specific fine-tuning is needed for a robust noisy→clean mapping [S] — [arXiv 2602.12432](https://arxiv.org/html/2602.12432v1)
- A webcam-gaze typing research repo turns each fixation's estimated mean and spread into a per-key probability distribution and runs a noisy-channel beam search; its finding: "character-level beam search is too weak a prior at ~1 key of gaze error" (with an order-4 character n-gram), so it was replaced by a lexicon decoder with selectable alternatives; it also resizes keys by next-character likelihood [P; hobby/research repo, not peer reviewed] — [m-karthika14/eye-gaze](https://github.com/m-karthika14/eye-gaze)

### Inferences
- The FUTO `char_embed_mixing` design (uncertain keystroke = weighted mixture of key-token embeddings) and the Vertanen search algorithm are complementary: the first lets a model consume a soft gaze observation directly; the second yields calibrated next-character posteriors for dwell-time scaling. A team could implement both on one 25–40M model.
- For an eye-gaze keyboard the lexicon/word-level constraint matters more than for touch because per-key noise is larger; the weak result with a 4-gram character LM suggests using a strong (neural or 12-gram) LM plus trie-constrained word hypotheses instead of free character beam search.
- Per-next-letter probabilities fall out of the same beam used for word completion: sum beam mass by next character. One search per keystroke can therefore serve dwell shortening, word completion and next-word candidates.

### Gaps
- Could not read the Gaines & Vertanen paper body: exact beam widths, per-model perplexity table, the byte-level and classifier-head numbers, hardware, and the abbreviation recogniser's accuracy are unverified; OSF contents unverified.
- No public technical details found for Microsoft SwiftKey's current on-device LM.
- No parameter count or latency for the neural LM in "Neural Search Space in Gboard Decoder" in the extracts.
- No 2024–2026 peer-reviewed work found applying a neural-LM noisy-channel decoder specifically to dwell-free or dwell-based eye-gaze typing.
- Official FUTO documentation and model licence could not be opened; architecture details come from a community reverse-engineering document.

---

## 4. Purpose-built tiny models: evidence, training cost, datasets, distillation, hybrids, personalisation

### Takeaway
There is now direct evidence that a 25–40M model trained for typing matches or beats what general 0.5–1.5B models deliver for next-word prediction, and training is cheap (under an hour on a laptop GPU for continued pretraining on ~150M tokens). The main risks are data licensing (DailyDialog is NC; synthetic data inherits the generator's terms) and the lack of a public AAC-specific benchmark.

### Cited Findings
- Production keyboards converge on ~25–42M parameters: Apple ~34M (estimate) [S] — [Simon Willison](https://simonwillison.net/2024/Jun/3/transformer-powered-predictive-text/); FUTO ~36M [P community doc] — [futo-basque](https://github.com/itzune/futo-basque/blob/main/RESEARCH.md); Typeling 25.4M [P] — [typeling](https://github.com/scarletkc/typeling)
- Diminishing returns from size: Qwen2.5-0.5B → 1.5B improved next-word top-1 from 19.0% to 20.1% at 2.4× cost (Lexo) [S] — [Lexo write-up](https://lexokeyboard.app/writeups/on-device-llm-keyboard/); Supra-50M beats the 25M model by only 1–2 KSR points zero-shot at ~2× compute per token [P] — [typeling model-plan](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md)
- Domain training matters more than size: Typeling-25M went from 33.5% zero-shot chat KSR to 43.1% after continued pretraining on ~150M tokens of chat/writing text [P] — [typeling model-plan / README](https://github.com/scarletkc/typeling)
- Training cost: ≈ 6 × parameters × tokens FLOPs → ~2.3e16 FLOPs for 25.4M parameters × 150M tokens; measured ~60k tokens/s on an RTX 5070 Ti laptop GPU, so 150–200M tokens take 40–55 minutes; full-parameter training (LoRA saves nothing at this size), bf16, AdamW, 512-token packing [P] — [typeling model-plan §4, §8](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md)
- From-scratch pretraining cost reference: MobileLLM on 1T tokens with 32 A100s takes days (table in README); MobileLLM-R1 pretraining phases are 2T tokens each, 4–5 days on 16×8 GPUs, with a logit-KL distillation mid-training stage from Llama-3.1-8B-Instruct (100B tokens, 1–2 days) [P] — [MobileLLM](https://github.com/facebookresearch/MobileLLM); [MobileLLM-R1](https://github.com/facebookresearch/MobileLLM-R1)
- A 25M base was pretrained on 20B FineWeb-Edu tokens (~800 tokens per parameter) [P, as reported from the model card] — [typeling model-plan](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md)
- Lexo's current design is a fine-tuned SmolLM2-360M with a word-scoring head (scores whole candidate words in one pass rather than decoding tokens); Typeling lists the same idea as a later option [S / P] — [Lexo](https://lexokeyboard.app/writeups/on-device-llm-keyboard/); [typeling model-plan §6](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md)
- Hybrid n-gram + neural: mixing the n-gram at weight 0.1 adds 0.2–0.3 points of KSR@3 and 1–2 points of precision [P] — [typeling model-plan §14](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md); BciPy ships a fixed-weight mixture adapter and warns against mixing more than one heavyweight model [P] — [BciPy](https://github.com/CAMBI-tech/BciPy/blob/main/bcipy/language/README.md)
- Personal vocabulary / cache: Typeling mixes n-gram probability with a document cache (default weight 0.1) and a user model of unigram+bigram counts whose weight grows with the amount learned, stored in a local JSON file; the same user model is fused into the neural predictor after search [P] — [typeling README](https://github.com/scarletkc/typeling)
- Context ablation: without context (prefix + word frequency only) KSR drops to ~15% and next-word accuracy to ~2%, versus 32% KSR with a trigram [P] — [typeling README](https://github.com/scarletkc/typeling)
- Quantisation at this scale: Q8_0 is nearly lossless and 27.55 MB for 25M parameters; 4-bit saves only ~10 MB and small models lose more; llama.cpp CPU binaries add ~50 MB on disk [P] — [typeling model-plan §5, §15](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md)
- 2017 precedent for distillation into a tiny keyboard LM: 7.4 MB RNN distilled from averaged teacher outputs [S] — [arXiv 1707.01662](https://arxiv.org/pdf/1707.01662)

**Datasets and licences**
- Permissive set used by Typeling: FineWeb (ODC-By 1.0), SODA (CC BY 4.0; synthetic dialogue generated by InstructGPT), WildChat-1M (ODC-By 1.0; real user-typed turns), OpenAssistant oasst2 (Apache-2.0), Ubuntu IRC from Common Pile (public domain); word lists LDNOOBW (CC BY 4.0) and SCOWL/ESDB (MIT-like) [P] — [typeling README](https://github.com/scarletkc/typeling)
- Caveat recorded by the same project: SODA was generated by an OpenAI model and OpenAI's terms restrict using outputs to build competing models [P] — [typeling model-plan §10](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md)
- DailyDialog: CC BY-NC-SA 4.0 (non-commercial; a Kaggle repackaging labelled CC0 conflicts with the original) [S] — [HF roskoN/dailydialog](https://huggingface.co/datasets/roskoN/dailydialog); [Papers with Code](https://paperswithcode.com/dataset/dailydialog)
- Tatoeba sentences: CC BY 2.0 FR [S] — [Tatoeba](https://tatoeba.org/en/user/profile/OpenSubtitles)
- Vertanen & Kristensson "Mining, analyzing, and modeling text written on mobile devices" (Natural Language Engineering 2021): mined forum/blog sentences (~624 MB zip) and language models hosted at Michigan Tech Digital Commons; no explicit licence statement found [S] — [Digital Commons](https://digitalcommons.mtu.edu/mobiletext); [keithv.com](https://keithv.com/pub/mobiletext/)
- AACText (Vertanen & Kristensson 2011): ~6,000 crowdsourced fictional AAC messages with train/dev/test splits [S] — [ResearchGate record](https://www.researchgate.net/publication/221012641_The_Imagination_of_Crowds_Conversational_AAC_Language_Modeling_using_Crowdsourcing_and_Large_Data_Sources)
- Gaines & Vertanen's fine-tuning used DailyDialog and BOLT among others, so their released `opt-350m-aac` model likely inherits non-commercial/LDC data provenance [S; provenance implication is my inference] — [arXiv 2501.10582](https://arxiv.org/html/2501.10582)

### Inferences
- A 20–50M model with a 15–16K vocabulary, trained on permissive chat corpora plus synthetic AAC-style dialogue, is the evidence-backed sweet spot; expect roughly +9–11 points of KSR over a trigram and +5 over a strong 12-gram AAC n-gram, based on the Typeling and Gaines & Vertanen results respectively (different test sets, not directly comparable).
- Because real AAC user text is scarce and private, synthetic generation from a frontier model is attractive, but the generator's terms of use must permit training a redistributable model; open-weight teachers under Apache 2.0 (Gemma 4, Qwen3.5) avoid the SODA-style ambiguity.
- A unigram/bigram user cache fused after search is a proven low-cost personalisation path; on-device LoRA exists (FUTO) but is reported as unstable/ineffective.

### Gaps
- No kNN-LM results for keyboard personalisation were found; only count-based caches.
- OpenSubtitles (OPUS) and Switchboard (LDC) licence terms were not confirmed in this session; Switchboard is LDC-distributed (membership licence) per general knowledge of the catalogue, unverified here.
- Licence of the AACText corpus and of the imagineville.org AAC n-gram models not found.
- No published study distilling a frontier LLM specifically into a ≤50M AAC keyboard LM with keystroke-savings evaluation.

---

## 5. Multilingual: which small models work beyond English; tokenisation issues for agglutinative languages

### Takeaway
Broad multilingual coverage exists only in the larger "small" models (Qwen3/3.5, Gemma 3/4), while every shipped keyboard-sized LM is monolingual (one ~25–40M model per language); English-centric BPE vocabularies fragment agglutinative words badly, so per-language tokenisers or character-aware output are needed.

### Cited Findings
- Qwen3: "100+ languages" [P] — [QwenLM/Qwen3 README](https://github.com/QwenLM/Qwen3); Qwen3.5 small: 248K vocabulary across 201 languages [S] — [Artificial Analysis](https://artificialanalysis.ai/articles/qwen3-5-small-models)
- Gemma 3 family: 140+ languages claimed [S] — [Gemma 3 model card mirror](https://gemma.ai/models/gemma-3/)
- SmolLM3: 6 native languages (EN/FR/ES/DE/IT/PT) [S] — [HF SmolLM3-3B](https://huggingface.co/HuggingFaceTB/SmolLM3-3B); Granite 4.0: "natively support multilingual capabilities" [P] — [Granite 4.0 README](https://github.com/ibm-granite/granite-4.0-language-models)
- FUTO's transformer LM is English-only officially; the community trains separate ~33–42M models per language (German, Greek, Portuguese, Basque) and the stock app passes only a–z keystroke tokens to the transformer, limiting non-Latin scripts (a fork patches Unicode keystrokes for Greek/Albanian) [P/S] — [futo-basque RESEARCH.md](https://github.com/itzune/futo-basque/blob/main/RESEARCH.md); [futo-keyboard-polyglot](https://github.com/armandodollia/futo-keyboard-polyglot)
- FUTO's keystroke tokens are 26 `<CHAR_A>..<CHAR_Z>` slots; typed text is normalised with NFD and combining marks stripped before mapping to keypress tokens [P] — [futo-basque RESEARCH.md](https://github.com/itzune/futo-basque/blob/main/RESEARCH.md)
- Lexo moved from one shared multilingual model to one model per language [S] — [Lexo write-up](https://lexokeyboard.app/writeups/on-device-llm-keyboard/)
- Apple's iOS 17 model launched for English, Spanish and French only [S] — [Michael Tsai](https://mjtsai.com/blog/2023/09/18/apples-new-transformer-powered-predictive-text-model/)
- Tokenisation: tokenisers trained on English-dominated data fragment Kazakh/Turkish/Finnish into far more tokens per word; dedicated tokenisers reach roughly 2–3× lower fertility than multilingual ones [S] — [SozKZ, arXiv 2603.20854](https://arxiv.org/pdf/2603.20854)
- English fertility with a 16K BPE: 1.29–1.44 tokens per word (measured) [P] — [typeling model-plan §3](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md); a self-published 2026 estimate gives 2–16 tokens per word for agglutinative languages vs 1.2–1.4 for English [S-weak] — [VerChol](https://www.wizwand.com/paper/69ae53d72d603e6de3e427e5)
- Low fertility alone can mislead: BPE can achieve it by memorising surface forms rather than morphology (Quechua benchmark) [S] — [arXiv 2602.04241](https://arxiv.org/pdf/2602.04241)
- A Kazakh project trains efficient small LMs from scratch for one language, and a Hinglish/Tenglish keyboard project uses a tiny on-device C++ LM that learns the user's own romanised typing [S] — [SozKZ](https://arxiv.org/pdf/2603.20854); [vikaskolanu/Keyboard-SLM](https://github.com/vikaskolanu/Keyboard-SLM)

### Inferences
- More tokens per word multiplies per-keystroke search cost (beam × tokens per word) and makes "next word" lists less useful in agglutinative languages, where predicting the next morpheme/suffix (i.e. good next-character and partial-word completion) is the valuable output. The character-marginalisation algorithm is language-agnostic and therefore the safer core for multilingual AAC.
- Practical plan: per-language 25–40M models with per-language 16K tokenisers (training cost is under an hour each after a base exists), plus an optional multilingual Gemma 4 / Qwen3.5 tier on capable devices.

### Gaps
- No keystroke-savings measurements for small neural LMs in Finnish/Turkish/Hungarian or other agglutinative languages were found.
- Per-language quality of Gemma 4 E2B / Qwen3.5 0.8B for next-word prediction is unmeasured in any source found.

---

## 6. What custom engineering could a strong team add?

### Takeaway
All the pieces for a dedicated "AAC keyboard LM" exist in the open: an Apache-2.0 25–50M base, a documented character-marginalisation decoder, a keystroke-token format for noisy input, a typing-simulation harness, and cheap training; what is missing publicly is the AAC-specific combination (soft gaze evidence + character posteriors + AAC-style data + export to web/mobile runtimes).

### Cited Findings (building blocks that exist)
- Base models to start from instead of training from scratch: Supra2-Medium-Base 25.4M and Supra-50M-Base, Apache 2.0, standard Qwen3/Llama architectures that llama.cpp runs [P] — [typeling model-plan §2](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md)
- Evaluation harness design: simulate typing 0,1,2,… letters of each word; metrics KSR (ghost text), precision, suggestions shown, KSR@3 (3-candidate bar), acc@i and top3@i, OOV, per-word perplexity, mean/p95/p99 latency, plus a mistyped-input variant and a simulated-Q4 switch [P] — [typeling README](https://github.com/scarletkc/typeling)
- AAC-oriented evaluation precedent: BciPy bundles phrase sets for testing language-model classes; Gaines & Vertanen evaluate per-character perplexity and simulated keystroke savings on AAC-like text and release datasets on OSF [P / S] — [BciPy language README](https://github.com/CAMBI-tech/BciPy/blob/main/bcipy/language/README.md); [ACL Anthology](https://aclanthology.org/2025.findings-emnlp.826/)
- Character-aware input/output options with evidence: (a) search over subword tokens — most accurate in Gaines & Vertanen but ~7× slower than byte-level [S] — [arXiv 2501.10582](https://arxiv.org/html/2501.10582); (b) keystroke tokens with embedding mixing (FUTO) [P] — [futo-basque](https://github.com/itzune/futo-basque/blob/main/RESEARCH.md); (c) word-scoring head (Lexo) [S] — [Lexo](https://lexokeyboard.app/writeups/on-device-llm-keyboard/); (d) a classification layer for characters — tested and found worse than search by Gaines & Vertanen [S] — [arXiv abstract](https://arxiv.org/abs/2501.10582)
- Distillation recipes: logit-KL distillation from an 8B teacher is used at scale in MobileLLM-R1 [P] — [MobileLLM-R1](https://github.com/facebookresearch/MobileLLM-R1); byte-prefix marginalisation enables distillation across different tokenisers (subword teacher → byte/char student) [S] — [arXiv 2607.22334](https://arxiv.org/pdf/2607.22334)
- Quantisation: SpinQuant (learned rotations, ICLR 2025) took Llama 3.2 1B from 19.4 to 53.4 tok/s on a phone [P link in MobileLLM README; S for numbers] — [SpinQuant](https://github.com/facebookresearch/SpinQuant); [ExecuTorch PR](https://github.com/pytorch/executorch/pull/6434/files); ternary training (BitNet) cuts CPU latency and energy substantially but needs bitnet.cpp kernels [P] — [microsoft/BitNet](https://github.com/microsoft/BitNet); at 25M parameters 4-bit yields little size gain and measurable loss, Q8 preferred [P] — [typeling model-plan §5](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md)
- Runtime paths relevant to Electron/Capacitor: llama.cpp GGUF as a sidecar/native plugin (FUTO and Lexo ship this on Android; a beam decoder in llama.cpp can share the context's KV cache across hypotheses instead of copying it) [P] — [typeling model-plan §14](https://github.com/scarletkc/typeling/blob/master/docs/model-plan.md); LiteRT-LM Web SDK with GPU default and GPU logit masking for constrained decoding, plus Swift/JS/Flutter APIs [P] — [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM); WebGPU via Transformers.js demonstrated for 1.2B models [P] — [Liquid cookbook](https://github.com/Liquid4All/cookbook)
- Windows-native reference: Typeling includes a prototype Windows TSF text service in Rust with a separate engine process [P] — [typeling README](https://github.com/scarletkc/typeling)
- Product-level ideas with precedent: key resizing by next-character likelihood (SliceType-style) in a gaze keyboard [P] — [m-karthika14/eye-gaze](https://github.com/m-karthika14/eye-gaze); abbreviation expansion of word-initial letters with conversational context (needs large models today: 64B LaMDA) [S] — [arXiv 2205.03767](https://arxiv.org/pdf/2205.03767)

### Inferences (proposed engineering programme)
1. **AAC keyboard LM, 25–50M parameters, 16K vocabulary**, continued-pretrained from an Apache-2.0 base on permissive conversational data plus synthetic AAC-style dialogue generated by an Apache-licensed teacher; add keystroke/soft-key tokens (FUTO-style embedding mixing) so gaze likelihood vectors can be fed in directly.
2. **One decoder for four outputs**: Vertanen-style prefix-constrained beam with KV-cache sharing, returning (a) next-character posterior for dwell scaling and gaze decoding, (b) word completions, (c) next-word candidates, (d) abbreviation expansion as a constrained decode where each word must start with the given initial; fuse with a lexicon trie, a 12-gram character or trigram word n-gram, and a user cache.
3. **Two-tier latency design**: n-gram answer in microseconds, neural re-rank within ~20–50 ms; optional 1–2B model (Gemma 4 E2B, Qwen3.5) only for phrase-level/abbreviation tasks on capable hardware.
4. **Quantisation-aware training** is worth testing only if the model grows beyond ~100M; at 25–50M ship 8-bit (~27–55 MB).
5. **Evaluation harness** reporting KSR, KSR@3, per-character perplexity and latency percentiles on AAC-like test sets (AACText, Vertanen's OSF sets, BciPy phrase sets), with simulated gaze noise at several sigma levels, and per-device runs on the four target classes.

### Gaps
- No public measurement of small-model inference via WebGPU/WASM inside Electron or Capacitor webviews for per-keystroke workloads; needs in-house benchmarking (covered by the runtimes researcher).
- No evidence yet that a small on-device model can do SpeakFaster-style initial-letter abbreviation expansion at useful accuracy; published results use a 64B model. Gaines & Vertanen's noisy-abbreviation recogniser may be the closest small-model result but its numbers could not be read.
- Core ML export and NPU (Copilot+/QNN) deployment of a custom 25–50M LM: no source found describing this for a keyboard LM.
- Network restriction note for the report writer: the following hosts need to be allowed (or checked manually) to verify [S] items — huggingface.co, arxiv.org, aclanthology.org, keithv.com, osf.io, liquid.ai, artificialanalysis.ai, ai.google.dev, developers.googleblog.com, docs.keyboard.futo.org, lexokeyboard.app, jackcook.com.
