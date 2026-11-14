# On-device, context-aware sentence-level reply prediction and personalisation for AAC (state as of November 2026)

**Verification note (read first).** From this environment only `github.com`, `developer.apple.com` and `developer.android.com` could be fetched directly. `arxiv.org`, `pmc.ncbi.nlm.nih.gov`, `nature.com`, `aclanthology.org`, `research.google`, `dl.acm.org`, `learn.microsoft.com`, `ai.google.dev`, `huggingface.co`, `keithv.com`, `pokristensson.com` and mirrors (ar5iv, alphaxiv) were all unreachable. Tags used below:
- **[P]** = read directly from the primary page.
- **[S]** = taken from a search-engine extract of the cited page (abstract-level; the full text was NOT read, so table-level details may be missing or slightly off).
- **[2nd]** = secondary/aggregator/vendor source; treat with caution.

---

## 1. What does the research say is achievable (keystroke savings, WPM, acceptance, agency)?

### Takeaway
The only rigorous eye-gaze evidence is still SpeakFaster (two ALS users: 29–60% higher text-entry rate; KSR for gaze typists about 0.32–0.36 against a field baseline of about −0.14, far below the 0.64–0.66 seen in simulation). Everything newer (2025–2026) is either qualitative (agency, authorship, identity), tiny-N, simulated, or vendor-reported; no published study yet measures a fully on-device "listen to the partner and propose 3–4 replies" system with eye-gaze users.

### Cited Findings
**SpeakFaster (Google; Cai et al., Nature Communications 2024)**
- Offline simulation: 57% more motor actions saved than a traditional predictive keyboard; 19 non-AAC participants on mobile showed motor savings in line with simulation and "relatively small" changes in typing speed; two ALS eye-gaze users achieved text-entry rates 29–60% above baseline [S] — [Nature Communications](https://www.nature.com/articles/s41467-024-53873-3); [arXiv 2312.01532](https://arxiv.org/abs/2312.01532)
- Simulated KSR for two usage strategies was 0.640 and 0.657 vs 0.482 for Gboard [S] — [Nature Communications](https://www.nature.com/articles/s41467-024-53873-3)
- For the eye-gaze typists the KSR achieved was only 0.32–0.36 (up from a negative baseline) [S] — [arXiv 2312.01532](https://arxiv.org/abs/2312.01532)
- Real-world baseline for gaze typing measured by SpeakFaster Observer: 8.1 ± 3.9 WPM and KSR −0.14 ± 0.83 (i.e. users typically press more keys than characters produced) [S] — [SpeakFaster Observer, CHI EA 2023](https://dl.acm.org/doi/full/10.1145/3544549.3573870). Google's blog cites typical gaze speeds of 8–10 WPM [S] — [Google Research blog](https://research.google/blog/speakfaster-revolutionizing-communication-for-people-with-severe-motor-impairments/)
- The two SpeakFaster LLMs were fine-tuned on about 1.8 million {context, abbreviation, full phrase} triplets synthesised from four public English dialogue datasets [S] — [Nature Communications](https://www.nature.com/articles/s41467-024-53873-3)
- Precursor (Cai et al., NAACL 2022): a 64B-parameter LLM exactly expands >70% of phrases with abbreviation length up to 10 when replying to the first turn of a dialogue (effective KSR up to about 77% on those exact expansions); adding ONE previous partner turn roughly doubles expansion accuracy vs no context; fine-tuned small T5 models beat the few-shot big LLM in almost all cases [S] — [ACL Anthology](https://aclanthology.org/2022.naacl-main.91/); [Google Research](https://research.google/pubs/context-aware-abbreviation-expansion-using-large-language-models/)

**Cambridge (Kristensson group)**
- Context-aware sentence retrieval (CHI 2020) is a modelling/design-engineering analysis: estimated keystroke savings 50–96% depending on word-prediction accuracy, context-tagging accuracy and sentence re-use; authors state such systems are "extremely difficult" to validate with AAC users [S] — [Kristensson et al. CHI 2020](https://www.pokristensson.com/pubs/KristenssonEtAlCHI2020.pdf)
- KWickChat (IUI 2022): GPT-2 with bag-of-keywords + dialogue history + persona; envelope analysis gives about 71% keystroke savings (with word prediction, WER threshold 0.65); two judges gave the best generated sentence per exchange a median 4/5 over 400 sentences (inter-rater 0.92). This was a semantic judgment, not a user study [P] — [KWickChat GitHub](https://github.com/CambridgeIIS/KWickChat); [paper](https://www.pokristensson.com/pubs/ShenEtAlIUI2022.pdf). The repo has no licence file [P] — [GitHub](https://github.com/CambridgeIIS/KWickChat)
- I found no 2024–2026 Kristensson/Shen paper on LLM sentence generation for AAC (searches returned only the 2020/2022 work) — see Gaps.

**Vertanen group**
- Gaines & Vertanen, "Adapting LLMs for Character-based AAC" (Findings of EMNLP 2025): converting a subword LLM to character predictions beats a classification layer, a byte-level LLM and n-grams; best model gave +5.5 percentage points absolute keystroke savings over an AAC n-gram baseline (simulation); domain adaptation on a curated AAC-like sentence set helps on simple conversational text [S] — [arXiv 2501.10582](https://arxiv.org/html/2501.10582v3). This is keystroke-level, not sentence-level.

**Valencia et al. and the Cornell/Maryland line (agency and authorship)**
- "The less I type, the better" (CHI 2023): 12 adult AAC users tried live LLM suggestions in three scenarios (extending short replies, answering biographical questions, requesting help); they saw savings in time, physical and cognitive effort, but insisted phrases must reflect their own style and preferences; the paper notes the shift from typing to "prompting and selecting" [S] — [ACM DL](https://dl.acm.org/doi/fullHtml/10.1145/3544548.3581560); [Google Research](https://research.google/pubs/the-less-i-type-the-better-how-ai-language-models-can-enhance-or-impede-communication-for-aac-users/)
- "Why So Serious?" (CHI 2025, Weinberg et al., Best Paper Honorable Mention): 7 interviews + study with 5 AAC users of four AI interfaces differing in agency. When timing matters (a joke), participants were willing to trade agency for speed — contrary to earlier design guidance. "Context Bubble Selection" was rated best for timely comments (4 of 5 positive); "Full-auto" was liked for speed/simplicity despite removing agency; "Keywords" and "Wizard" each drew 2 negative scores (numbers differ between arXiv versions) [S] — [arXiv 2410.16634](https://arxiv.org/abs/2410.16634); [ACM DOI](https://dl.acm.org/doi/10.1145/3706598.3714102); [Cornell Chronicle](https://news.cornell.edu/stories/2025/05/ai-tools-help-people-speech-disabilities-make-timely-jokes)
- "I, Robot? Ultra-Personalized AI-Powered AAC" (CHI 2026, autoethnography by an AAC-using researcher): 7 months logging all AAC output, fine-tuning (final model a fine-tuned GPT-4.1-mini, i.e. cloud), 3 months daily use. Findings: logging itself changed his behaviour before any AI; training "selectively amplified or muted" aspects of identity; suggestions sometimes resurfaced private details out of context; model worked well in structured settings but struggled in fast social situations and nudged conversation in unintended directions; "accuracy alone proved insufficient"; needs fine-grained context and ongoing control over how much the model says [S] — [arXiv 2509.13671](https://arxiv.org/abs/2509.13671); [Cornell Chronicle, May 2026](https://news.cornell.edu/stories/2026/05/what-does-it-mean-train-ai-speak-you)
- "It's Complicated: On the Design and Evaluation of AI-Powered AAC Interfaces" (CHI 2026 workshop paper, Frisch et al.): argues against relying on quantitative metrics alone; calls for pluralistic, participatory evaluation; presents no user trial [S] — [arXiv 2606.24854](https://arxiv.org/abs/2606.24854)
- Choudhury et al. (Findings of IJCNLP-AACL 2025): keyword + emotion → sentence generation for AAC; notes LLM authorship can lead others to question AAC users' agency and the validity of what they say; recommends clear guidance on when AI should not be used [S] — [ACL Anthology](https://aclanthology.org/2025.findings-ijcnlp.100/)

**Other 2024–2026 systems (all cloud-LLM based)**
- SPICA (Univ. at Buffalo, 2026): plug-in that indexes user information into a personal knowledge base and retrieves on demand, no retraining; evaluated on 205 synthetic AAC user profiles (GPT-5 as teacher) plus a qualitative study with ONE real AAC user [S] — [UB tech report 2026-27](https://cse.buffalo.edu/tech-reports/2026-27.pdf); [ACM](https://dl.acm.org/doi/10.1145/3742413.3789116)
- Speak Ease (2025): ASR of partner + context-aware LLM output + personalised TTS; evaluated only by a feasibility study and focus group with speech-language pathologists [S] — [arXiv 2503.17479](https://arxiv.org/abs/2503.17479)
- SocializeChat: GPT-4 sentence suggestions from personal memory records and social context for older users with speech impairment [S] — [arXiv 2510.19017](https://arxiv.org/abs/2510.19017v1)
- AACessTalk (CHI 2025; minimally verbal autistic children, symbol cards — a different population): 2-week deployment with 11 dyads; children selected 2,244 recommended cards; parents followed guidance in about 78% of turns; source code public [S] — [arXiv 2409.09641](https://arxiv.org/abs/2409.09641)
- HALO (Unbabel, medRxiv 2025): LLM proposes persona-conditioned full-sentence replies; ALS user selects with a single eyebrow sEMG contraction. No WPM figures surfaced [S] — [medRxiv](https://www.medrxiv.org/content/10.1101/2025.09.24.25336481v1.full)
- NeuroVoice (MIT-licensed hackathon project, Oct 2026; cloud Claude; simulated ALS user, 56 test sentences): initials→5 sentences. Keystroke savings 11.6% (LLM only), 25.5% (+ conversation context), 44.8% (+ personal memory via vector search), 42.3% (+ time/wearable state); top-1 accuracy 12.5% → 35.7% with personal memory; a plain word-frequency predictive keyboard still saved MORE keystrokes (53.0%); p50 latency 3.0–3.8 s [P] — [GitHub](https://github.com/mariavarelacaraballo/neuroVoice). Not peer-reviewed; synthetic user.

**Commercial moves**
- Lingraphica "Conversations" (launched July 2026, adults 18+): transcribes the partner's speech and suggests replies the user can review, edit and speak; suggestions are steered by selected keywords and "type of reply"; vendor test with 13 adult users: 100% completed a conversation, a 44-percentage-point improvement over a traditional layout [S, vendor claim] — [BusinessWire](https://www.businesswire.com/news/home/20260708229328/en/Lingraphica-Supports-Spontaneous-Communication-With-New-Conversations-Tool); [Lingraphica](https://lingraphica.com/resources/introducing-conversations/). This is the closest shipping analogue to the target design.
- Smartbox Grid 3 "Smart Prompt": part of Grid's "Online AI tools" (opt-in, i.e. cloud): correct spelling/grammar, expand abbreviations, fill missing letters, generate words/phrases for a topic, expand or simplify sentences; applied after typing [S] — [Smartbox](https://thinksmartbox.com/news/create-ai-powered-tools-with-smart-prompt/); [Bridges Canada](https://www.bridges-canada.com/blogs/bridges-news/new-ai-command-in-grid). I could not confirm a feature literally named "Fix".
- Tobii Dynavox: 2026 blog series on AI stressing that users must "always be able to easily opt out of what is AI generated"; a RESNA webinar (22 Sept 2026) on "AI at Tobii Dynavox"; no specific generative reply feature confirmed [S] — [Tobii Dynavox blog](https://www.tobiidynavox.com/blogs/aac-news/how-ai-is-improving-aac); [RESNA](https://learn.resna.org/products/tech-tuesday-with-tobii-dynavox)
- General-purpose on-device reply suggestion already ships outside AAC: ML Kit Smart Reply (up to 3 English replies, on-device) and Samsung Keyboard's on-device suggested replies on Galaxy S25 [S] — [ML Kit](https://developers.google.com/ml-kit/language/smart-reply/android); [Android Authority](https://www.androidauthority.com/samsung-keyboard-suggested-replies-3524723/)

### Inferences
- Realistic expectation for a gaze user: roughly a 30–60% rate gain when suggestions hit, not the 2–5x that simulated KSR implies. The gap between simulated (0.64) and real gaze KSR (0.32–0.36) is the single most important calibration number: scanning/reading candidates and recovering from misses eat much of the saving.
- The NeuroVoice ablation and the "I, Robot" account point the same way: personal memory/knowledge, not a bigger model or generic conversation context, is what moves top-1 accuracy.
- Sentence suggestion should be a layer on top of a good word predictor with seamless fallback; a pure sentence system can lose to plain word prediction.

### Gaps
- No peer-reviewed 2025–2026 study with eye-gaze users of partner-speech-driven reply suggestion; no published acceptance-rate figures for sentence suggestions in AAC.
- Could not confirm "Grid 3 Fix", Tobii Dynavox generative reply features, Proloquo/Flexspeak/Voiceitt/Cognixion/Apple reply-generation features, or any "Proactive AAC" paper.
- No newer Kristensson/Shen or Microsoft Research sentence-level AAC paper was found; this may reflect search limits rather than absence.
- SpeakFaster per-user latency, error rates and learning-curve details could not be read (PMC/Nature blocked).

---

## 2. Interaction designs for steering generation with minimal input

### Takeaway
Evidence favours a mixed-initiative ladder: zero-input context-driven candidates for time-critical turns, then keyword/initial-letter steering, then spelling fallback. Which rung is preferred depends on time pressure: under time pressure users accept less agency.

### Cited Findings
- Initials-only abbreviation with spelling-out fallback, plus "KeywordAE" (mix fully/partly spelled words with initials) is the SpeakFaster design; context of one partner turn about doubles expansion accuracy [S] — [Nature Communications](https://www.nature.com/articles/s41467-024-53873-3); [NAACL 2022](https://aclanthology.org/2022.naacl-main.91/)
- Keyword-to-sentence (bag of keywords + history + persona) yields about 71% modelled keystroke savings; keywords alone give lower WER than the retrieved sentence [S/P] — [KWickChat](https://github.com/CambridgeIIS/KWickChat); [ACM](https://dl.acm.org/doi/10.1145/3490099.3511145)
- Selecting from context "bubbles" (pick the bit of the partner's utterance to respond to) beat keyword entry and a step-by-step wizard for timely remarks; fully automatic generation was liked despite low agency [S] — [Why So Serious?](https://arxiv.org/abs/2410.16634)
- Reply-type + keyword steering is what Lingraphica shipped (2026) [S] — [BusinessWire](https://www.businesswire.com/news/home/20260708229328/en/Lingraphica-Supports-Spontaneous-Communication-With-New-Conversations-Tool)
- Emotion/tone as an explicit control is non-trivial: LLM and human interpretations of emotion representations (words, VAD values, emoji) diverge [S] — [IJCNLP-AACL 2025 Findings](https://aclanthology.org/2025.findings-ijcnlp.100/)
- Users asked for control over "how much the model says" and fine-grained context [S] — [I, Robot?](https://arxiv.org/abs/2509.13671)
- Drafting while the partner is still speaking: spoken-dialogue research generates a response (or a short preface) before end-of-turn using an intent-readiness detector plus voice-activity projection; speculative guessing wastes compute when intent shifts mid-utterance [S] — [Preface generation, arXiv 2607.23204](https://arxiv.org/pdf/2607.23204); [COLING 2025](https://preview.aclanthology.org/setup/2025.coling-main.249); [Don't Wait to Reply, arXiv 2607.03093](https://arxiv.org/pdf/2607.03093). Commercial "eager end-of-turn" reports about 150 ms median latency reduction (vendor figure) [2nd] — [Telnyx/Deepgram](https://telnyx.com/release-notes/automatic-eager-end-of-turn-deepgram-flux)

### Inferences
- For a gaze user the partner's turn (several seconds) is free compute time: candidates can be regenerated on each ASR partial and be on screen at end-of-turn. Unlike a voice bot, wasted speculation costs only battery, not user time.
- Recommended ladder: (0) auto candidates spread across intents (yes / no / question / comment-joke); (1) intent chips; (2) tap a word in the partner transcript as topic; (3) type 1–2 keywords or initials and re-rank/regenerate under constraint; (4) select-then-edit; (5) ordinary typing with word prediction.

### Gaps
- No head-to-head controlled comparison of initials vs keywords vs intent chips with AAC users. No study of "regenerate with a nudge" or incremental refinement in AAC.

---

## 3. Which on-device model sizes give acceptable replies, and how fast? OS-provided models

### Takeaway
Hardware can deliver it: 1–2B-class models decode at about 35–70 tokens/s on a current flagship iPhone, so 3–4 candidates of 10–15 tokens fit in roughly 1–2 s plus prompt processing. Quality evidence for 1–4B models on short personal replies is thin, and OS-provided models are an unsafe sole dependency because of small context, guardrails/refusals and device coverage.

### Cited Findings
**Speed**
- iPhone 17 Pro, Gemma 4 E2B: LiteRT-LM 61.1 tok/s (497 MB), Cactus 50.6, MLX Swift 4-bit 49.1 (3,010 MB), llama.cpp Q4_K_M 38.8 (191 MB mmap). Qwen3-1.7B on iPhone 17 Pro: Core AI 67.6, MLX 65.1, LiteRT-LM 49.3 tok/s. Mac Studio M4 Max, Qwen3 0.6B: MLX 555.9 tok/s [P] — [apple-silicon-llm-bench](https://github.com/john-rocky/apple-silicon-llm-bench)
- Sustained load throttles: over 10 minutes unplugged, LiteRT-LM fell from 57.1 to 35.4 tok/s (about −38%) and MLX from 45.7 to 25.1 (about −45%) [P] — [apple-silicon-llm-bench](https://github.com/john-rocky/apple-silicon-llm-bench)
- MLX on iPhone 17 Pro vs iPad Pro M5: LFM2.5 1.2B 4-bit at 124 tok/s (iPad) vs 60–70 tok/s (iPhone); iPad 1.2–2.2x faster, gap widening with context length; Gemma 3 1B time-to-first-token rose from 407 ms at 47 prompt tokens to 1,330 ms at 690 tokens [S, snippets partly inconsistent] — [R. Takkar benchmark, mirror](https://hn.jakechampion.name/reader/https://rickytakkar.com/blog_russet_mlx_benchmark.html)
- Google claims Gemma 3 1B prefill of up to 2,585 tok/s on mobile GPU (prefill, not decode; vendor claim) [S] — [Google Developers Blog](https://developers.googleblog.com/id/gemma-3-on-mobile-and-web-with-google-ai-edge)
- Older/mid-range Android is far slower: anecdotal Gemma 3n E4B about 8 tok/s on a Galaxy Z Fold 4; E2B 0.33 tok/s on a Pixel 4a [2nd, anecdotal] — [HN thread](https://hn.matthewblode.com/item/44044199)
- llama.cpp server supports what a multi-candidate design needs: parallel slots (`-np`), continuous batching (default on), `cache_prompt` (only the differing suffix is processed), `n_cmpl` (N completions from one prompt), `grammar`/`json_schema` constraints, `n_probs`, draft-model speculative decoding, and per-request LoRA scaling (requests with different LoRA settings are not batched together) [P] — [llama.cpp server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- Batched decoding raises aggregate throughput a lot (README example: 7B Q8 from about 42 tok/s at 1 sequence to about 465 at 32; machine unspecified, old) [2nd] — [batched-bench README mirror](https://rust-digger.code-maven.com/src/localllm-0.2.0/llama.cpp/examples/batched-bench/README.md)

**Quality of small models**
- Fine-tuned small T5 models beat a few-shot 64B LLM on abbreviation expansion [S] — [NAACL 2022](https://aclanthology.org/2022.naacl-main.91/)
- Small models (0.5–5B) were evaluated for empathetic dialogue with human ratings, comparing zero-shot and fine-tuned [S] — [arXiv 2505.15065](https://arxiv.org/pdf/2505.15065)
- LoRA-adapted Qwen2.5 from 0.5B to 7B all reached the same automatic style-rewriting score (0.69) in a single-user case study: size affected efficiency, not measured quality [S] — [Small Is Enough, arXiv 2607.29238](https://arxiv.org/abs/2607.29238)

**OS-provided models**
- Apple Foundation Models: on-device guardrails check input and output and throw `guardrailViolation`; the model may also refuse ("Sorry, I can't help with that"); `Guardrails.permissiveContentTransformations` skips guardrail checks for string output only (not guided generation), and even then "the on-device system language model still has a layer of safety" and may refuse; Apple updates the model with OS releases and tells developers to re-run prompt tests [P] — [Apple docs](https://developer.apple.com/documentation/foundationmodels/improving-the-safety-of-generative-model-output)
- Developers report false-positive guardrail hits on mainstream news, and behaviour changing after an OS update (iOS 26.5) [S] — [Apple forum 787736](https://developer.apple.com/forums/thread/787736); [Apple forum 835777](https://developer.apple.com/forums/thread/835777)
- Context is 4,096 tokens shared by instructions, history, tool output and response; model about 3B parameters [2nd] — [natashatherobot](https://www.natashatherobot.com/p/apple-foundation-models); [drobinin](https://drobinin.com/consulting/foundation-models-apple-intelligence/putting-apple-foundation-models-in-a-real-app/)
- Apple supports custom LoRA adapters for the system model, but they are tied to a specific model version (retrain on each base update) and reportedly need an entitlement [2nd] — [blakecrosley.com](https://blakecrosley.com/blog/foundation-models-custom-adapters)
- Android Gemini Nano via AICore / ML Kit GenAI: Prompt API (text and multimodal), rewriting, proofreading, summarisation, embeddings, on-device speech recognition; AICore applies input and output safety filters; Google states there are "token limits, device hardware limitations, and model capability boundaries" and that developers are responsible for safety [P] — [Android Developers](https://developer.android.com/ai/gemini-nano). Prompt API "performs best" on Pixel 10 (nano-v3); model version varies by device; inference reportedly foreground-app only [S] — [Android Developers Blog](https://android-developers.googleblog.com/2025/10/ml-kit-genai-prompt-api-alpha-release.html)
- Windows Phi Silica: designed for Copilot+ PCs with a 40+ TOPS NPU; content classified severity 3+ is blocked, with configurable sensitivity; context reported as 2k at launch with 4k following; LoRA supported via experimental APIs [S] — [Phi Silica docs](https://learn.microsoft.com/en-us/windows/ai/apis/phi-silica); [transparency note](https://learn.microsoft.com/en-us/Windows/ai/apis/phi-silica-transparency-note); [content moderation](https://learn.microsoft.com/en-us/windows/ai/apis/content-moderation); [Windows blog](https://blogs.windows.com/windowsexperience/2024/12/06/phi-silica-small-but-mighty-on-device-slm/)

### Inferences
- Latency budget (my arithmetic from the figures above): 4 × 15 = 60 output tokens. At about 50 tok/s single stream that is about 1.2 s sequentially on a flagship phone; batching 4 sequences over one cached prefix should be nearer 0.5–0.8 s. Prompt processing is the larger risk (about 1.3 s for about 700 tokens on a 1B model), so keep a stable cached prefix (persona + retrieved facts + history) and feed only the new partner words. On an ordinary no-GPU Windows laptop or mid-range Android tablet, assume a several-fold slowdown: a 0.3–1B specialised model is the realistic choice there.
- Stream candidates as they decode and order by intent so the first one is readable within about 300–500 ms.
- OS models are useful as an optional zero-download backend but cannot be the only engine: guardrails can block exactly the speech AAC users need (see section 8), context is small, behaviour changes with OS updates, and coverage excludes ordinary Windows laptops, older iPads and most mid-range Android.

### Gaps
- No human-rated study of 1–4B models (Gemma 3/3n/4, Qwen3, Phi-4-mini, Llama 3.2, SmolLM3, LFM2) specifically on short conversational replies was found. No measured numbers for 4-way batched decoding on phones, CPU-only Windows laptops or NPU Copilot+ PCs. Exact Gemini Nano token limits and device list not retrieved.

---

## 4. Personalisation to the user's style and life

### Takeaway
Retrieval of personal facts and past utterances has the strongest and cheapest evidence; per-user LoRA adds style on top but gives small gains when user data is scarce. Few-shot prompting plateaus after 4–5 examples and does not capture informal everyday style, which is the argument for fine-tuning.

### Cited Findings
**Retrieval and memory**
- Retrieval-augmented personalisation gave about +14.9% average over a non-personalised baseline on LaMP vs about +1.1% for per-user PEFT; combining both was best (about +16.0%); weak PEFT gains were attributed to limited data per user [S] — [Salemi & Zamani (as surfaced by search)](https://arxiv.org/pdf/2409.09510v2)
- Opposite claim: One-PEFT-Per-User (OPPU, EMNLP 2024) reports beating retrieval- and profile-augmented baselines on all 7 LaMP tasks, and is compatible with retrieval/profile augmentation [S] — [ACL Anthology](https://aclanthology.org/2024.emnlp-main.372.pdf). The two results conflict; base models and setups differ.
- Personal memory via vector search tripled top-1 sentence accuracy (12.5% → 35.7%) in a simulated ALS user [P] — [NeuroVoice](https://github.com/mariavarelacaraballo/neuroVoice)
- EmbeddingGemma: 308M parameters, multilingual, under 200 MB RAM quantised, Matryoshka output 768 → 128 dims, under about 22 ms on EdgeTPU; Gemma licence (open weights, commercial use allowed, with use restrictions — not MIT) [S] — [Google Developers Blog](https://developers.googleblog.com/en/introducing-embeddinggemma/); [model overview](https://ai.google.dev/gemma/docs/embeddinggemma)
- sqlite-vec: dual Apache-2.0/MIT, pure C with no dependencies, runs on Linux/macOS/Windows/WASM/small devices, float/int8/binary vectors, metadata and partition columns, pre-v1 ("expect breaking changes") [P] — [GitHub](https://github.com/asg017/sqlite-vec). Do not confuse with sqliteai/sqlite-vector (Elastic License 2.0) [2nd] — [GitHub](https://github.com/ntklink/sqlite-vector)
- Android ships an on-device Embedding API paired with AppSearch [P] — [Android Developers](https://developer.android.com/ai/gemini-nano)
- Mem0-style memory: headline LoCoMo score 92.5 uses a cloud frontier model; a fully local Ollama config exists; third parties report about 58–66% for older/local setups and dispute LoCoMo's validity [S/2nd] — [Mem0 docs](https://docs.mem0.ai/core-concepts/memory-evaluation); [memory-benchmarks](https://github.com/mem0ai/memory-benchmarks); [dev.to comparison](https://dev.to/varun_pratapbhardwaj_b13/5-ai-agent-memory-systems-compared-mem0-zep-letta-supermemory-superlocalmemory-2026-benchmark-59p3)

**Parameter-efficient fine-tuning**
- mlx-lm supports LoRA (default), DoRA and full fine-tuning, QLoRA on quantised models, chat/completions/text JSONL data; memory levers: batch size (default 4), `--num-layers` (default 16), gradient checkpointing; reference: Mistral-7B at about 250 tokens/s training on an M1 Max 32 GB; adapters can be fused [P] — [mlx-lm LORA.md](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/LORA.md)
- StyleTunedLM (INLG 2024): LoRA style tuning on ten authors; 5% or 35% of the data gave clearly inadequate style learning; more data kept improving [S] — [ACL Anthology](https://aclanthology.org/2024.inlg-main.34/); code — [GitHub](https://github.com/cauchy221/StyleTunedLM)
- "Small Is Enough" (2026): per-user LoRA on Qwen2.5 0.5B–7B, training pairs built by local helper LLMs from the user's own documents; single case study (73 paragraphs, scientific writing); gains favoured naturalisation more than recovery of personal style [S] — [arXiv 2607.29238](https://arxiv.org/abs/2607.29238)
- Practitioner rules of thumb: 200–500 clean examples to start, 1,000+ safer; rank about 16, 1–3 epochs; overfitting shows as repeated constructions [2nd] — [N. Deville notes](https://notes.nicolasdeville.com/nicai/fine-tuning/); [D. Lopes](https://didierlopes.beehiiv.com/p/fine-tuning-an-llm-on-my-blog-posts)
- Hypernetworks that emit a per-user LoRA in one forward pass on device (no gradient descent): Gemma3-1B-IT and Gemma-2B; generated rank-4 LoRA about 0.63–0.78M parameters, rank-32 about 5.0–6.2M; best or near-best ROUGE-1 on several LaMP/LongLaMP tasks [S] — [arXiv 2609.24979](https://arxiv.org/abs/2609.24979)
- Google's PEFT personalisation for abbreviation expansion reports 68.3% accuracy (model details not seen) [S] — [arXiv 2312.14327](https://arxiv.org/pdf/2312.14327)
- OS route: Apple system-model LoRA adapters and Phi Silica LoRA exist but are version-locked or experimental [2nd/S] — [blakecrosley.com](https://blakecrosley.com/blog/foundation-models-custom-adapters); [Microsoft](https://learn.microsoft.com/en-us/windows/ai/apis/content-moderation)

**Does style imitation work?**
- "Catch Me If You Can? Not Yet" (EMNLP 2025): 400+ real authors, 40,000+ generations per model; few-shot beats zero-shot but stays far from the author, worst in informal domains; gains plateau after 4–5 examples [S] — [arXiv 2509.14543](https://arxiv.org/abs/2509.14543)
- Contrasting result on essays/product text: few-shot reached near-perfect style matching by a perplexity-based verifier, and model size mattered less than prompting strategy; text remained more predictable than human writing [S] — [arXiv 2509.24930](https://arxiv.org/pdf/2509.24930)

**Federated/private**
- PriME (EMNLP 2025) merges LoRA modules from consenting users for a target user [S] — [arXiv 2503.18008](https://arxiv.org/pdf/2503.18008). Gboard trains on-device LMs with federated learning + differential privacy [S] — [Google Research](https://research.google/pubs/federated-learning-of-gboard-language-models-with-differential-privacy/)

### Inferences
- Order of work: (1) personal knowledge file + retrieval over past utterances; (2) 4–5 retrieved same-partner/same-topic past replies as in-context style examples; (3) optional overnight LoRA on the user's Mac/PC, exported to the phone/tablet. LoRA should carry style; facts should come only from retrieval so they stay editable and deletable.
- A few hundred to a few thousand of the user's own short messages is the plausible minimum for LoRA to help; below that rely on retrieval. Timing for a 1B QLoRA should be minutes to an hour or two on Apple silicon, extrapolating from 250 tok/s on a 7B model (not measured).
- Federated learning does not fit a small open-source project with no server; "private" here simply means local.

### Gaps
- No LaMP-style numbers for 0.3–1B bases; no measured on-device (iPad/Android) LoRA training time; ExecuTorch/LiteRT on-device training and llama.cpp finetune status not verified. Licences of mlx-lm, Unsloth and embedding alternatives (MiniLM, bge, gte, nomic, Qwen3-Embedding) not confirmed here — the runtimes/model-catalogue researchers should cover them.

---

## 5. Bootstrapping when the user can no longer produce much new text

### Takeaway
Use historical text plus synthetic expansion by a larger model, but expect a distribution gap; logging and training on a life's messages raises real third-party privacy and identity issues.

### Cited Findings
- SpeakFaster trained on about 1.8M synthetic triplets derived from public dialogue datasets rather than user data [S] — [Nature Communications](https://www.nature.com/articles/s41467-024-53873-3)
- Google: prompting public LLMs to synthesise data resembling real typing improved small on-device LM next-word accuracy by 19.0% and 22.8% relative vs a standard public-data baseline, yet "a significant distribution gap" to real user data remains [S] — [arXiv 2404.04360](https://arxiv.org/pdf/2404.04360); [Google Research blog 2025](https://www.research.google/blog/synthetic-and-federated-privacy-preserving-domain-adaptation-with-llms-for-mobile-applications/)
- "Small Is Enough" builds training pairs from the user's own documents with local helper LLMs [S] — [arXiv 2607.29238](https://arxiv.org/abs/2607.29238)
- SPICA generated personalised and non-personalised dialogues per profile with a teacher model [S] — [UB tech report](https://cse.buffalo.edu/tech-reports/2026-27.pdf)
- Message banking gives a ready seed corpus: one ALS phrase set had 2,082 banked messages [S] — [arXiv 2305.03819](https://arxiv.org/pdf/2305.03819)
- Seven months of logging preceded fine-tuning in the autoethnography; private details later resurfaced out of context, and logging changed behaviour [S] — [I, Robot?](https://arxiv.org/abs/2509.13671)

### Inferences
- Pipeline: import (messages, email sent-folder, social posts, banked phrases, transcripts) → keep only the user's own turns as targets, partner turns as context → local larger model on the user's computer writes varied partner prompts for each real reply and paraphrases (real replies stay as gold) → train. Keep synthetic and real examples labelled so synthetic can be down-weighted.
- Third parties: strip or pseudonymise names in training text, keep raw archives encrypted and local, per-contact exclusion, and a "never suggest" list; retrieval stores should be partitioned by who is present so content from partner A is not surfaced in front of partner B.

### Gaps
- No study evaluates whether synthetic expansion of a real AAC user's small corpus preserves their style, or how users judge it. No AAC-specific guidance on third-party consent for imported message archives was found.

---

## 6. Multimodal and situational context on-device

### Takeaway
Cheap signals (time, calendar, location label, enrolled partner voice) are feasible now; continuous camera scene understanding is technically possible but poorly evidenced for benefit, and face recognition carries heavy legal burden.

### Cited Findings
- On-device diarisation is light: pyannote-segmentation-3.0 ONNX export is about 6.6 MB and runs on CPU through sherpa-onnx with CAM++ speaker embeddings [2nd] — [OpenWhispr](https://openwhispr.com/blog/local-speaker-diarization); a 2026 paper reports real-time factor 0.22 (vs 1.84) on an M4 laptop CPU with stride acceleration [S] — [arXiv 2606.08505](https://arxiv.org/pdf/2606.08505); streaming on-device diarisation was benchmarked on a Pixel 4 in 2022 [S] — [arXiv 2210.13690](https://arxiv.org/pdf/2210.13690)
- Diarisation only separates anonymous speakers; naming one requires an enrolled voiceprint, i.e. biometric data [2nd] — [OpenWhispr](https://openwhispr.com/blog/local-speaker-diarization)
- Face templates used for identification are special-category data under GDPR Art. 9 (explicit consent or another condition); Illinois BIPA covers face geometry with a private right of action; Texas CUBI requires informed consent [2nd, compliance-vendor source] — [GDPRLocal](https://gdprlocal.com/smart-glasses-and-gdpr/)
- Small VLMs: FastVLM targets time-to-first-token at high resolution (Core ML/MLX); SmolVLM2 goes down to 256M and adds video; published scores are not comparable across families [2nd] — [aiidelist](https://aiidelist.com/blog/fastvlm-vs-smolvlm2)
- OS options: Apple Foundation Models accept images (guardrails apply to both modalities) [P] — [Apple docs](https://developer.apple.com/documentation/foundationmodels/improving-the-safety-of-generative-model-output); ML Kit offers on-device image description and speech recognition [P] — [Android Developers](https://developer.android.com/ai/gemini-nano)
- Extra context can hurt: adding time + wearable state lowered top-1 from 35.7% to 21.4% in NeuroVoice, so its authors use it only for tone [P] — [GitHub](https://github.com/mariavarelacaraballo/neuroVoice)
- Sustained inference throttles by 38–45% within 10 minutes on a phone [P] — [apple-silicon-llm-bench](https://github.com/john-rocky/apple-silicon-llm-bench)

### Inferences
- Use voice enrolment with each partner's explicit consent ("who is here" = a manually confirmable chip, auto-suggested by voice), not face recognition. Run vision only on demand ("look") or at scene change, never continuously.
- Feed context as short structured lines and test each signal by ablation; more context is not automatically better.

### Gaps
- No measured battery or latency figures for small VLMs on iPad/Android; no AAC study quantifying the benefit of scene context; household-exemption applicability to a user's private enrolment of friends was not established.

---

## 7. Evaluation before user studies

### Takeaway
Simulated keystroke-saving rate on dialogue corpora is the standard offline measure but overestimates real gaze benefit roughly two-fold; pair it with top-k exact/semantic match, a time model that charges for reading and selection, and human-validated judging.

### Cited Findings
- KSR in simulation over public dialogue datasets is the SpeakFaster method (0.64–0.66 simulated vs 0.32–0.36 for gaze users) [S] — [Nature Communications](https://www.nature.com/articles/s41467-024-53873-3); [arXiv](https://arxiv.org/abs/2312.01532)
- Envelope analysis with a WER acceptance threshold (0.65) is the KWickChat method [P] — [GitHub](https://github.com/CambridgeIIS/KWickChat)
- Simulated-persona protocol with temporal split (memory from days 1–5, test on days 6–8), same LLM across ablations, reporting top-1, top-5, keystroke savings, latency [P] — [NeuroVoice](https://github.com/mariavarelacaraballo/neuroVoice)
- Sentence prediction pays only if it beats word prediction after selection cost (1–2 s per gaze selection) [P] — [NeuroVoice](https://github.com/mariavarelacaraballo/neuroVoice)
- Curated AAC-like sentence sets exist from the Vertanen group and improve conversational prediction [S] — [arXiv 2501.10582](https://arxiv.org/html/2501.10582v3); [Vertanen & Kristensson crowdsourced AAC LM](https://keithv.com/pub/imagine/)
- LLM-as-judge: near-random agreement with humans on multi-party social dialogue for current frontier judges; verbosity and position biases; judges must be validated against task-specific human labels [S] — [ICLR 2026](https://iclr.cc/virtual/2026/10014636); [survey arXiv 2411.16594](https://arxiv.org/pdf/2411.16594)
- AAC researchers warn against purely quantitative evaluation [S] — [It's Complicated](https://arxiv.org/abs/2606.24854)

### Inferences
- Report: KSR; top-1/top-4 "acceptable" rate (embedding similarity threshold calibrated on human labels); expected seconds per utterance under a gaze cost model (dwell per key, read time per candidate, miss penalty); candidate-set diversity; refusal and blandness rates; and hallucinated-personal-fact rate. Evaluate on the user's own held-out messages with a temporal split, in addition to DailyDialog/Switchboard/PersonaChat-style corpora.

### Gaps
- Could not verify the names of SpeakFaster's four datasets, nor current availability/licences of Vertanen's AAC sets, "TurkingAAC", TopicalChat or Switchboard for this use; no AAC-specific multi-turn dialogue corpus with real AAC users was found.

---

## 8. Risks

### Takeaway
The main risks are social and identity-related rather than technical: suggestions shift what the user says (more positive, more generic), partners discount AI-suspected speech, personal models leak private facts, and platform safety filters conflict with users' right to say anything.

### Cited Findings
- Smart replies increased speed and positive emotional language; people suspected of using algorithmic replies were rated more negatively [S] — [Cornell Chronicle on Hohenstein et al., Scientific Reports 2023](https://news.cornell.edu/stories/2023/04/study-uncovers-social-cost-using-ai-conversations)
- AAC users want phrases in their own style; AI can constrain agency and authentic self-expression [S] — [Valencia et al. 2023](https://dl.acm.org/doi/fullHtml/10.1145/3544548.3581560)
- LLM involvement may lead others to question AAC users' agency and the validity of their words [S] — [IJCNLP-AACL 2025 Findings](https://aclanthology.org/2025.findings-ijcnlp.100/)
- Personal model resurfaced private details out of context and steered conversations unintentionally [S] — [I, Robot?](https://arxiv.org/abs/2509.13671)
- Vendor stance: users must be able to opt out of AI-generated content easily [S] — [Tobii Dynavox](https://www.tobiidynavox.com/blogs/aac-news/how-ai-is-improving-aac)
- Censorship is an existing harm in AAC: many devices lack profanity/slang; adult filtering damages autonomy and identity; 73–88% of participants in one study had "no means" to communicate about sexuality topics [S] — [USSAAC webinar slides](https://isaac-online.org/wp-content/uploads/USSAAC-Webinar-April-27-2022-1.pdf); [USSAAC "Uncensored AAC"](https://ussaac.org/event/uncensored-aac-exploring-aac-access-to-profanity-and-slang/); [Cerebral Palsy Alliance](https://cerebralpalsy.org.au/news-stories/exploring-taboo-language-in-aac-systems/)
- Apple guardrails target "self-harm, violence, and adult materials" and the model may still refuse in permissive mode; Phi Silica blocks severity 3+ content; AICore filters input and output [P/S] — [Apple docs](https://developer.apple.com/documentation/foundationmodels/improving-the-safety-of-generative-model-output); [Microsoft](https://learn.microsoft.com/en-us/windows/ai/apis/content-moderation); [Android](https://developer.android.com/ai/gemini-nano)

### Inferences
- Design rules: nothing is spoken without explicit selection; suggestions are clearly the user's choice (no auto-speak except an opt-in mode for time-critical interjections); always include at least one non-agreeable/neutral candidate to counter positivity bias; never state personal facts that are not in the user-editable knowledge file; show why a suggestion appeared (retrieved memory) and allow one-gesture "forget"; user-controlled profanity/intimacy/end-of-life settings with no vendor filter in the default open-weights path; a "private mode" that suppresses memory-based suggestions when others can see the screen.

### Gaps
- No quantitative study of bias or hallucination rates in AAC reply suggestion; no peer-reviewed work on end-of-life vocabulary and LLM filters in AAC.

---

## 9. Custom engineering beyond off-the-shelf

### Takeaway
The best-supported bets are a small specialised suggester trained on synthetic context/abbreviation/reply triplets, hard-constrained decoding, shared-prefix batched candidates, and retrieval-first personalisation with an optional overnight LoRA; learned re-ranking from acceptance logs is plausible but unproven in AAC.

### Cited Findings
- Task-specific fine-tuned small models can beat a much larger few-shot LLM on abbreviation expansion, using about 1.8M synthetic triplets [S] — [NAACL 2022](https://aclanthology.org/2022.naacl-main.91/); [Nature Communications](https://www.nature.com/articles/s41467-024-53873-3)
- Fine-tuning an LLM for ad-hoc abbreviation expansion substantially beats older noisy-channel models (2026) [S] — [Gorman, CAWL 2026](https://aclanthology.org/2026.cawl-1.6/)
- Constrained output, multi-completion, prompt caching, parallel slots, draft-model speculative decoding and per-request LoRA are already in llama.cpp (MIT-licensed project) [P] — [llama.cpp server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- Per-user LoRA without on-device gradient descent via hypernetworks on 1B Gemma [S] — [arXiv 2609.24979](https://arxiv.org/abs/2609.24979)
- Precedent for personalised re-ranking: Google's on-device smart-reply patent pairs an off-device-trained suggester with a personalisation model built from the user's past sent replies [S] — [US10846618B2](https://patents.google.com/patent/US10846618B2/en)
- Predictive generation before end of turn [S] — [arXiv 2607.23204](https://arxiv.org/pdf/2607.23204)

### Inferences
- Distil a frontier model into a 300M–1B "reply suggester": inputs = persona facts, last partner turns, optional intent tag, optional initials/keywords; outputs = one short reply. Train with intent tags so four candidates can be forced to differ by intent instead of relying on sampling.
- Constrained decoding: a token-level mask (or grammar) enforcing "word i starts with letter i" for initials, and required-keyword constraints; this turns typed letters into a guarantee, which matters because every miss is costly for gaze users.
- Re-ranker: log shown/selected/edited/rejected locally; start with a simple contextual bandit or pairwise preference model over features (intent, length, retrieval score, partner); keep exploration small and visible.
- Check model licences: Gemma-family (Gemma terms) and some others are not MIT/Apache; an MIT app can load them but should not bundle weights without honouring their terms.

### Gaps
- No public evidence yet for a distilled sub-1B reply model's quality on personal conversation, or for bandit re-ranking in AAC; both need the project's own experiments.
