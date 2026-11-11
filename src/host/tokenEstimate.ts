/**
 * Token estimation for the AMP attention budget.
 *
 * The budget is stated to the model as a token count, so the host must not
 * measure it in UTF-8 bytes or `length / 4`: those undercount CJK payloads by
 * roughly 2-4x and would let a "1200 token" package carry three times that.
 *
 * This is a calibrated upper bound, not a tokenizer:
 *
 * - CJK ideographs, kana and hangul count as one token per character. Real
 *   DeepSeek-style BPE usually emits 1-2 characters per token for these, so the
 *   estimate errs high and the budget stays honest.
 * - Everything else (ASCII letters, digits, punctuation, whitespace, emoji
 *   bytes) averages one token per four UTF-16 code units.
 *
 * A conservative over-estimate costs a little unused budget; an under-estimate
 * silently blows the context window. The asymmetry justifies the bias.
 *
 * Deterministic and allocation-light: this runs on every serialized item AMP
 * considers, including candidates it later excludes.
 */

/** True for a code point a CJK/kana/hangul token usually covers on its own. */
function isDenseScript(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK punctuation (。、「」)
    (code >= 0x3040 && code <= 0x30ff) || // hiragana, katakana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
    (code >= 0xac00 && code <= 0xd7af) || // hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK compatibility forms
    (code >= 0xff00 && code <= 0xffef) || // fullwidth forms (，；：！？)
    (code >= 0x20000 && code <= 0x2fa1f) // CJK extensions B-F
  )
}

/**
 * Estimate the token cost of `text` for a DeepSeek-style BPE.
 *
 * @param text - the exact string the model would receive, or AMP's serialized
 * projection when measuring compiler accounting.
 * @returns a non-negative integer; empty input yields 0.
 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  let dense = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (isDenseScript(code)) dense += 1
  }
  const other = Math.max(0, text.length - dense)
  return dense + Math.ceil(other / 4)
}

/** Stable identity of the estimator, folded into the context-cache signature. */
export const TOKEN_ESTIMATOR_ID = 'cjk-v1'
