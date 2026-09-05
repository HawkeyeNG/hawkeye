/**
 * Per-cell confidence from token logprobs.
 *
 * WHY THIS EXISTS. The party pass returned **0 nulls in 21,630 cells** while
 * calling 10,983 of them (50.8%) empty, and 2,813 of those are provably wrong —
 * the words cell on the same row carries a value. The model does not say "I
 * cannot read this"; it says "there is nothing there", and downstream that
 * publishes as a zero vote.
 *
 * Schema alone cannot fix that. Forbidding the empty string (see ec8a_prompt.js
 * note 3) makes abstention EXPRESSIBLE, but a model that is confidently wrong
 * will now confidently write BLANK instead. What distinguishes "I can see this
 * cell is empty" from "I could not read it and guessed empty" is the model's own
 * uncertainty at the moment it chose that token — which vLLM has been computing
 * on every request since the first run and nobody has ever asked for.
 *
 * The alignment is exact, not heuristic: concatenating the returned tokens
 * reproduces the response text byte for byte, so a running offset gives every
 * token a character span, and a character span in the JSON gives a cell.
 *
 * Deliberately NOT a threshold. This reports the numbers; where the line sits is
 * a calibration decision to be made against the 2,813 known-false blanks, on the
 * evidence, not guessed here.
 */

/** Token stream -> [{token, logprob, start, end}], offsets into the joined text. */
export function tokenSpans(logprobs) {
  const content = logprobs?.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  let at = 0;
  for (const t of content) {
    const tok = typeof t.token === 'string' ? t.token : '';
    out.push({ token: tok, logprob: typeof t.logprob === 'number' ? t.logprob : null, start: at, end: at + tok.length,
      top: Array.isArray(t.top_logprobs) ? t.top_logprobs : null });
    at += tok.length;
  }
  return out;
}

/**
 * Character spans of every value for `key`, in document order.
 *
 * Guided decoding emits object keys in schema order, so the Nth occurrence of
 * `"figures":` is the Nth cell of the parsed array. That correspondence is what
 * makes this safe without a full JSON parser.
 */
export function valueSpans(text, key) {
  const chr34 = String.fromCharCode(34);
  const spans = [];
  const needle = `"${key}"`;
  let i = 0;
  for (;;) {
    const k = text.indexOf(needle, i);
    if (k === -1) break;
    let j = k + needle.length;
    while (j < text.length && (text[j] === ' ' || text[j] === ':')) j += 1;
    let end = j;
    if (text[j] === chr34) {                       // a quoted string value
      end = j + 1;
      // BACKSLASH via charCode: a literal escape does not survive this
      // repo tooling reliably, and getting it wrong silently truncates a value.
      const BACKSLASH = String.fromCharCode(92);
      while (end < text.length && !(text[end] === chr34 && text[end - 1] !== BACKSLASH)) end += 1;
      end += 1;
    } else {                                     // null, a number, true/false
      while (end < text.length && !',}\n '.includes(text[end])) end += 1;
    }
    spans.push({ start: j, end });
    i = end;
  }
  return spans;
}

/** Worst (least confident) token logprob overlapping a span. */
export function spanConfidence(spans, from, to) {
  let min = null;
  let n = 0;
  let sum = 0;
  for (const s of spans) {
    if (s.end <= from || s.start >= to) continue;
    if (s.logprob === null) continue;
    n += 1;
    sum += s.logprob;
    if (min === null || s.logprob < min) min = s.logprob;
  }
  return n ? { minLogprob: min, meanLogprob: sum / n, tokens: n } : null;
}

/**
 * Confidence for every `key` value in a response, in document order.
 * Returns [] rather than throwing when logprobs were not requested — this is an
 * enrichment, and a pass that cannot get it must still produce its reading.
 */
export function cellConfidences(text, logprobs, key = 'figures') {
  const spans = tokenSpans(logprobs);
  if (!spans.length) return [];
  return valueSpans(text, key).map(({ start, end }) => ({
    start, end, text: text.slice(start, end), ...(spanConfidence(spans, start, end) || { minLogprob: null, meanLogprob: null, tokens: 0 }),
  }));
}
