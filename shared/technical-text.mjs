// Pure comparison used by backend and browser; documentary text is never mutated.
export function cleanText(value) {
  return value.replace(/\s+/gu, " ").trim();
}
export function normalizeForMatch(value) {
  return cleanText(value).normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toLowerCase();
}
export function isSupportedDtcCode(value) {
  return /^(?:[A-Z][A-Z0-9:-]{2,31}|[A-F0-9]{6}|\d{5}:\d{3}|\d{2,5}-\d{1,3})$/u.test(value);
}
