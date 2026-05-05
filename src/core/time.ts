export const nowIso = (): string => new Date().toISOString();

export const plusMsIso = (ms: number): string => new Date(Date.now() + ms).toISOString();

export const epochSeconds = (): number => Math.floor(Date.now() / 1000);
