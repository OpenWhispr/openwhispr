# Android local note cleanup candidate

The previous balanced Qwen2.5 1.5B model changed a conditional commitment from “can collect” to “will collect” in the installed Android app, including at temperature zero. It also invented task dates in an earlier repeated run. Routing tests passed while the generated text was wrong.

The candidate replaces the balanced model with **Qwen3 1.7B Q4_K_M** and separates Android personal-note cleanup from the shared meeting/formatting instructions. Meeting prompts, custom actions and iOS prompt selection retain their existing routes. Android personal cleanup keeps the original questions, conditions and sentence order, removes unquoted fillers, and fixes grammar/punctuation. Raw note content is retained separately.

The runtime explicitly disables Qwen3 thinking and uses the SDK's parsed answer content. It rejects an empty answer instead of exposing a reasoning-only response. Requests retain their specified temperature; personal Generate Notes uses 0.3. Qwen3 uses top_k 20, top_p 0.8, min_p 0 and presence penalty 1.5. The optional Qwen2.5 0.5B model keeps its existing inference path; this change does not establish its note quality.

## Artifact and attribution

- Base model: [Qwen3 1.7B](https://huggingface.co/Qwen/Qwen3-1.7B), [Apache-2.0 license](https://huggingface.co/Qwen/Qwen3-1.7B/blob/main/LICENSE).
- Quantization: [Unsloth Qwen3 1.7B GGUF](https://huggingface.co/unsloth/Qwen3-1.7B-GGUF), pinned revision `d7f544eead698dbd1f15126ef60b45a1e1933222`, file `Qwen3-1.7B-Q4_K_M.gguf`.
- Size: 1,107,409,472 bytes. SHA-256: `b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897`.
- Cached Qwen2.5 balanced weights fail the new artifact's readiness check. The app downloads and verifies the replacement before use; it does not silently accept the old file as Qwen3. Model credits identify Unsloth's quantization separately from the base model.

## Offline screening before building

CPU-host screening used verified llama.cpp b11701 with synthetic notes only. The host runtime differs from Android's llama.rn 0.12.3. These checks do not establish Android speed, memory requirements or full model accuracy.

The final instruction/model combination was checked against 13 fixtures with two seeds each: conditional commitments, scheduling, self-correction, quoted filler and identifiers, paragraphs, proper names, nested negations, decimal amounts, already-clean text, rough punctuation, quoted instructions, questions and subject-verb agreement. Manual comparison found all 26 outputs preserved the tested facts, questions, conditions and uncertainty. The grammar fixture corrected agreement in both runs. **Both outputs for the paragraph fixture merged the two paragraphs**, so paragraph-format preservation is not accepted.

Rejected comparisons remain evidence, not alternate accepted implementations: the old 1.5B model still changed modality and names under isolated instructions; the first Qwen3 instruction set retained filler and damaged capitalization; a later instruction set turned a question into a statement. Higher-precision Q8 alone did not resolve these issues. Explicit preservation instructions improved the selected Q4 candidate without increasing the download beyond the previous balanced model's size.

Inputs, exact commands, raw outputs and manual reviews are retained in the private review root's `text-evaluation/` directory, particularly `expanded-fixtures.json`, `qwen3-q4-grammar-expanded-runs.json` and `v65-candidate-review.json`. Prompt/model screening did not require Android builds.

## Software checks and acceptance boundary

The four new failing integration expectations cover Android personal prompt routing, rejection of the obsolete balanced artifact, non-thinking runtime configuration/parsed answer handling, and rejection of a reasoning-only result. The small-model completion path remains covered. These tests verify contracts, not model semantics.

Node 24 verification passes 306 suites / 3,541 tests, TypeScript and formatting. Scoped ESLint has zero errors and four existing `no-void` warnings. An initial Node 25 full run failed because the installed SQLite native addon targets Node 24; the unchanged dependency passes with the repository-pinned runtime.

## Installed Android checks

Exactly one combined local APK build was installed for this candidate, with zero cloud builds. Runtime is `bd8938cbdf8e9da3984ecb46b30410f04dd649fc`; APK SHA-256 is `b2d0e895d1d7b03c781c04dcc4c5bcad1b0ea6abc8e0b67d1be5fee716674198`. The retained and installed hashes match. Generated native build outputs were removed afterward.

The native Models screen rejected the obsolete balanced artifact, downloaded its replacement and displayed Qwen3 Ready/Selected after verification. With Wi-Fi and mobile data disabled, two built-in Generate Notes runs preserved every tested condition, number, negation and uncertainty in the collection fixture. A question fixture retained the question, unknown customer acceptance, conditional discussion and unbooked meeting. A scheduling fixture also preserves all five facts without inventing deadlines for Mira or Leon. These are five native runs across four fixtures, including the grammar limitation below. The raw note remains separate and unchanged by enhancement.

**Grammar cleanup is not accepted yet.** The installed model changed “we was” to “we were” but retained “the train were delayed” and “there is two drafts.” Facts were preserved, but the host grammar pass did not transfer fully to Android. Do not launch another build in response to this single case: complete the native fixture batch, investigate runtime/prompt differences offline and group any justified fixes.

The owned synthetic note and QA actions remain for continued testing, Qwen3 selected and radios off. Original v65 screenshots and `v65-native-note-quality.json` retain exact inputs/results; these captures are separate from the earlier 171-image packet. Title inference completed, but the custom note title prevented visible assessment of the generated title. Physical-device/OEM measurements, full spoken capture and provider acceptance remain separate gaps in the readiness audit.

## Follow-up: dictionary context and unused title requests

The next native check used the same installed APK, with no new build. A second scheduling run preserved all five facts and generated **Android onboarding review** for the owned note after its title was set to Untitled. Returning to the note list verified persistence. The owned fixture now has that generated title.

The Dictionary screen then exposed 39 entries (1 manual / 38 learned), including ordinary words timestamped during whole-note fixture replacements. `extractCorrections` compared removed and added words anywhere in the two bodies, so one unrelated replacement could learn ten false spellings. Native note requests append dictionary entries, while the original host screening had no dictionary suffix. Those comparisons therefore did not isolate runtime differences.

Two further instruction alternatives were rejected offline: minimal-edit wording lost rough-text punctuation, and proofreading wording retained fillers/grammar errors. Temperature zero still merged paragraphs. No prompt or sampling change was selected. In a paired diagnostic, the same grammar input/model/seed corrected all three errors without a suffix but reproduced the native errors with a synthetic dictionary suffix. That suffix was built from observed/test words; it is not an exact capture of the earlier native request and does not establish a sole cause. Exact commands and all 88 follow-up outputs are retained under `text-evaluation/`, with `v66-comparison-review.json` describing each comparison.

The v66 source batch fixes two reproduced issues, subsequently verified together in v67:

- Correction learning rejects pure tail typing/backspacing and replacements retaining less than half the word occurrences. It keeps single-word substitutions, genuine corrections within retained sentences, multiple corrections and dictionary deduplication. This is a conservative automatic-learning rule; users can still add words explicitly. It does not delete existing entries.
- Android Generate Notes checks the current title before starting automatic title inference. A custom title, including one typed while note generation is pending, avoids a second AI request whose result would be discarded. Untitled notes retain automatic titles; iOS behavior stays unchanged.

The earlier learned test entries remain present and must be accounted for in subsequent model comparisons; do not claim a clean dictionary or silently remove unrelated entries. The v67 verification below covers the source batch on one consolidated APK.

The combined source batch passes 307 suites / 3,551 tests, TypeScript and formatting. Scoped lint has zero errors and nine pre-existing NoteEditor inline-style warnings. The two title-request regressions and the wholesale-replacement/partial-word learning regressions failed before their fixes. No APK or cloud build was created during the v66 source investigation. The subsequent v67 native verification used one local build, as recorded below.

## Consolidated v67 native verification

Runtime `ce8f0ccbfaf565c06f65b2f85c71df9cebc944a2` includes both repairs and the Qwen3 candidate. **One local build, zero cloud builds** covered the complete batch. The ARM64 build passed in 65 seconds; retained and installed APK hashes match `46276438404bdc0c4da952f021f34dcb42266fdd47339f840fa46eb23e8533ed` (167,891,246 bytes). Generated native build output was removed after verification.

With both networks disabled, whole-note replacement typed in slow chunks and a partial final-word deletion/restoration left Dictionary at **39 entries**. A selected-word ADB replacement did not add a word; a subsequent single-character correction from Zentrovio to Zentrovix did, bringing the count to40. This verifies that genuine correction learning remains active, without claiming every replacement is detected. Deleting only the owned Zentrovix test entry through the app returned the count to39; prior entries were preserved.

Generate Notes retained the custom title **Android onboarding review**, updated the enhanced body and completed exactly one local inference. Setting the same note to Untitled and generating again completed two inferences and produced **Silver draft needed**. The title and enhanced content persisted after returning to the list and reopening; My notes retained the exact original synthetic text. Filtered diagnostics and visible results agree. These are title/learning checks on already-clean text, not a new grammar-quality benchmark.

Private `v67-native-verification.json`, `v67-install-verification.json`, filtered title logs and original v67 captures preserve the evidence. The v68 evidence pass adds inspected v65–v67 originals to the private packet, now182 captures with matching source/embedded hashes. The owned note/QA actions remain for ongoing quality work; radios remain off, host audio disabled, and dictionary count39. Earlier grammar and paragraph limitations, physical-phone measurements, full spoken capture and provider acceptance remain open. Reuse this APK for independent checks and batch any further justified source changes before rebuilding.

## V69 offline comparison — no app build

Two further instruction variants were screened against grammar, paragraphs, conditional statements, questions and rough punctuation, with three seeds each and the same synthetic dictionary suffix used in v66. Both preserve paragraph breaks in all three runs and retain the tested conditions/questions. Both fail all three rough-punctuation runs; one leaves one agreement error and the other leaves two in every grammar run. All30 raw outputs and commands are retained, with `text-evaluation/v69-comparison-review.json` recording rejection. Neither variant is selected. No product prompt, model or sampling change and no local/EAS build follows this experiment.
