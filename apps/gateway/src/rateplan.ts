export function rateEpoch(now: number): number {
  return Math.floor(now / 60_000);
}

export function rateAllows(hits: number, limit: number): boolean {
  if (limit <= 0) return true;
  return hits <= limit;
}
