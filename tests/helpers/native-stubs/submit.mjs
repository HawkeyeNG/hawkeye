// What outbox.ts takes from submit.ts. remintSession is the test's to decide.
const N = (globalThis.__native ??= {});
export const filePart = (uri, name, type) => ({ uri, name, type });
export const remintSession = async () => (N.remint ? N.remint() : null);
