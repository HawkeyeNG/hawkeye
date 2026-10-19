const N = (globalThis.__native ??= {});
export const bootstrapAuth = async () => { if (N.bootstrapAuth) await N.bootstrapAuth(); };
export const getToken = () => N.secure?.get('hawkeye.auth.token') ?? null;
export const renewSession = async () => (N.renewSession ? N.renewSession() : false);
