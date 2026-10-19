const N = (globalThis.__native ??= {});
N.queued ??= [];
export const queueJob = async (job) => { N.queued.push(job); };
