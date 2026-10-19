// Keys come back as themselves, with their params, so a test can assert which line was chosen.
export const t = (k, p) => (p ? `${k} ${JSON.stringify(p)}` : k);
export const lazyT = (o) => o;
export const currentLangForOtp = () => 'en';
