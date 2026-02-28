const SEARCH_CACHE_TTL_MS = 180_000;
const SEARCH_CACHE_CLEANUP_MS = 30_000;

const searchCache = new Map();

function makeSearchCacheKey(guildId, userId, messageId) {
  return `${guildId}-${userId}-${messageId}`;
}

function deleteSearchCache(key) {
  const entry = searchCache.get(key);
  if (!entry) return false;
  clearTimeout(entry.timeout);
  return searchCache.delete(key);
}

function setSearchCache(key, value, ttlMs = SEARCH_CACHE_TTL_MS) {
  deleteSearchCache(key);

  const timeout = setTimeout(() => {
    searchCache.delete(key);
  }, ttlMs);
  timeout.unref?.();

  searchCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
    timeout,
  });

  return key;
}

function getSearchCache(key) {
  const entry = searchCache.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    deleteSearchCache(key);
    return null;
  }

  return entry.value;
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of searchCache.entries()) {
    if (entry.expiresAt <= now) {
      deleteSearchCache(key);
    }
  }
}, SEARCH_CACHE_CLEANUP_MS);
cleanupTimer.unref?.();

module.exports = {
  SEARCH_CACHE_TTL_MS,
  makeSearchCacheKey,
  setSearchCache,
  getSearchCache,
  deleteSearchCache,
};
