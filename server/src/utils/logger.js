const stamp = () => new Date().toISOString().slice(11, 19);
const paint = (code, s) => `\x1b[${code}m${s}\x1b[0m`;

export const log = {
  info: (...a) => console.log(paint(36, `[${stamp()}] ·`), ...a),
  ok: (...a) => console.log(paint(32, `[${stamp()}] ✓`), ...a),
  warn: (...a) => console.warn(paint(33, `[${stamp()}] !`), ...a),
  error: (...a) => console.error(paint(31, `[${stamp()}] ✗`), ...a),
};
