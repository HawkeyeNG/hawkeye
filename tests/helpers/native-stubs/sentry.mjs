const N = (globalThis.__native ??= {});
export const init = (o) => { N.sentryOptions = o; };
export const captureException = () => {};
