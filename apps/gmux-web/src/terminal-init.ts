// Per-session prefetch cache. Avoids re-downloading and re-processing on
// every tab switch. Key: session ID. Value: extracted bytes or null if empty.
export const prefetchCache = new Map<string, Uint8Array | null>()
