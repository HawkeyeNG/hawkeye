// What outbox.ts takes from submit.ts. remintSession is the test's to decide.
const N = (globalThis.__native ??= {});
export const filePart = (uri, name, type) => ({ uri, name, type });
export const remintSession = async () => (N.remint ? N.remint() : null);
// submit.ts ERRORS lookup; a test may set N.errorLine to answer for some codes.
export const errorLine = (code) => (N.errorLine ? N.errorLine(code) : null);
