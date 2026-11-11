/**
 * Budget token estimation.
 *
 * The budget is announced to the model as a token count, so a Chinese-heavy
 * package measured with `length / 4` would be wrong by roughly 3x. These tests
 * pin the CJK-aware upper bound and the estimator identity that invalidates the
 * compiled-context cache whenever the estimator changes.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { TOKEN_ESTIMATOR_ID, estimateTokens } from '../src/host/tokenEstimate.ts'

test('empty and ASCII text use a four-characters-per-token average', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(estimateTokens('hello world'), 3)
})

test('CJK, kana and hangul count one token per character', () => {
  assert.equal(estimateTokens('上下文压缩'), 5)
  assert.equal(estimateTokens('トークン'), 4)
  assert.equal(estimateTokens('토큰'), 2)
})

test('mixed scripts add the two rates', () => {
  // 2 dense + ceil(3 / 4) = 3
  assert.equal(estimateTokens('abc中文'), 3)
  // 2 dense + ceil(4 / 4) = 3
  assert.equal(estimateTokens('压缩abcd'), 3)
})

test('a Chinese package is never undercounted by the old length / 4 rule', () => {
  const text = '请你审计现有项目的上下文压缩、剪枝与缓存优化功能，并探索更好的算法。'
  const legacy = Math.ceil(text.length / 4)
  const estimate = estimateTokens(text)
  assert.ok(estimate >= text.length, 'one token per CJK character is the upper bound')
  assert.ok(estimate > legacy * 2, `estimate ${estimate} must dominate the len/4 value ${legacy}`)
})

test('the estimator identity is stable and versioned', () => {
  assert.equal(TOKEN_ESTIMATOR_ID, 'cjk-v1')
})
