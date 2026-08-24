/**
 * resilience.h — the PURE logic of Phase 4 field resilience, kept free of Arduino/ESP-IDF
 * dependencies so it compiles and runs ON THE HOST (firmware/test/host/) as well as on the
 * device. Everything here is decision logic over plain values; main.cpp owns the I/O.
 *
 * Covers (audit F-1/F-2/F-3/F-5 + the roadmap's connect/backoff items):
 *   - id validation (player/session), matching the server's TOPIC_ID_RE exactly (F-3);
 *   - the per-device monotonic sequence with an NVS high-water mark, so `sq` never repeats
 *     across reboots and the server's (player_id, seq) dedupe is sound (F-1);
 *   - the two-file backlog rotation (append to the newest generation, flush the oldest,
 *     drop the OLDEST half when full — the old code silently dropped the newest fixes);
 *   - flush cursor checkpointing (persist the offset every N records; a crash re-sends at
 *     most one checkpoint window, which the server dedupes by sq);
 *   - record-age expiry for the flush path and the boot purge (F-5);
 *   - reconnect backoff with jitter, bounded, so a dead AP is probed gently and a fleet of
 *     trackers doesn't thundering-herd the broker;
 *   - a tiny numeric field extractor so the flush path can read a record's gts without a
 *     JSON parser.
 */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>

// ----------------------------------------------------------------------------------------
// F-3: id validation — EXACTLY the server's TOPIC_ID_RE /^[A-Za-z0-9._-]{1,64}$/. An id with
// a '/' silently black-holes every fix (the broker routes it, the server's single-level '+'
// never matches); an over-long id overflows the packet buffer. Reject at ENROLLMENT.
static const size_t FT_ID_MAX = 64;

static inline bool ft_id_char_ok(char c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
         c == '.' || c == '_' || c == '-';
}

static inline bool ft_id_valid(const char* s) {
  if (s == nullptr || s[0] == '\0') return false;
  size_t n = 0;
  for (; s[n] != '\0'; n++) {
    if (n >= FT_ID_MAX) return false;
    if (!ft_id_char_ok(s[n])) return false;
  }
  return n >= 1 && n <= FT_ID_MAX;
}

// ----------------------------------------------------------------------------------------
// F-1: the sequence. `next` is the seq for the next fix; `hw` is the PERSISTED high-water
// mark — the guarantee is next < hw at all times, so after any reboot resuming from the
// stored hw can never reuse a value. ft_seq_boot_resume returns the state to run with and
// the caller MUST persist st.hw before publishing anything.
struct FtSeqState {
  uint32_t next; // seq to hand out next
  uint32_t hw;   // persisted ceiling; when next reaches it, persist a new one
};

static const uint32_t FT_SEQ_MARGIN = 4096; // one NVS write per ~7 min at 10 Hz

static inline FtSeqState ft_seq_boot_resume(uint32_t stored_hw) {
  FtSeqState st;
  st.next = stored_hw;                 // everything below stored_hw may have been used
  st.hw = stored_hw + FT_SEQ_MARGIN;   // caller persists this BEFORE the first publish
  return st;
}

/** Take the next seq. Returns true when st.hw changed and MUST be persisted (before use). */
static inline bool ft_seq_take(FtSeqState* st, uint32_t* out_seq) {
  *out_seq = st->next++;
  if (st->next >= st->hw) {
    st->hw = st->next + FT_SEQ_MARGIN;
    return true;
  }
  return false;
}

// ----------------------------------------------------------------------------------------
// Backlog: two files, each capped at half the budget. Append always goes to the file with
// the HIGHEST generation; flush always drains the LOWEST. When the active file is full:
// if the other slot is empty it becomes the new active (fresh generation); if the other
// slot still holds an UNFLUSHED older half, that OLDER half is deleted — drop-oldest, so a
// long outage keeps the most recent fixes (the old single-file code kept the oldest and
// dropped every new fix once full).
struct FtBkFile {
  bool exists;
  uint32_t size; // bytes
  uint32_t gen;  // 0 = never used; monotonically increasing otherwise
  uint32_t off;  // flush cursor (bytes consumed)
};

struct FtBkState {
  FtBkFile f[2];
  uint32_t next_gen; // generation to assign to the next fresh file (starts at 1)
};

struct FtBkAppendPlan {
  int target;        // 0 or 1: file index to append to
  bool start_fresh;  // true: (re)create the target with gen = new_gen, off = 0
  /** true: the file CURRENTLY AT `target` is the unflushed OLDER half and is being sacrificed
   *  (drop-oldest). I/O CONTRACT: the ONLY file the caller may delete is BK_PATH[target] —
   *  the other slot holds the NEWEST stashed fixes and must never be touched. (A previous
   *  main.cpp misread this flag as "delete the other file" and destroyed both halves.) */
  bool drop_oldest_at_target;
  uint32_t new_gen;  // valid when start_fresh
};

static inline int ft_bk_newest(const FtBkState* st) {
  if (!st->f[0].exists && !st->f[1].exists) return -1;
  if (!st->f[0].exists) return 1;
  if (!st->f[1].exists) return 0;
  return st->f[0].gen >= st->f[1].gen ? 0 : 1;
}

static inline int ft_bk_oldest(const FtBkState* st) {
  if (!st->f[0].exists && !st->f[1].exists) return -1;
  if (!st->f[0].exists) return 1;
  if (!st->f[1].exists) return 0;
  return st->f[0].gen <= st->f[1].gen ? 0 : 1;
}

/** Where should the next record be appended? cap_half = per-file byte budget. */
static inline FtBkAppendPlan ft_bk_append_plan(const FtBkState* st, uint32_t cap_half) {
  FtBkAppendPlan p;
  p.start_fresh = false;
  p.drop_oldest_at_target = false;
  p.new_gen = st->next_gen;
  int active = ft_bk_newest(st);
  if (active < 0) { // nothing yet: start file 0
    p.target = 0;
    p.start_fresh = true;
    return p;
  }
  if (st->f[active].size < cap_half) { // room in the active file
    p.target = active;
    return p;
  }
  // Active is full: move to the other slot. If an unflushed OLDER half sits there, it is the
  // one being dropped — and it sits AT p.target, which start_fresh recreates.
  int other = 1 - active;
  p.target = other;
  p.start_fresh = true;
  p.drop_oldest_at_target = st->f[other].exists;
  return p;
}

/** Which file should the flush drain next? -1 = nothing to flush. */
static inline int ft_bk_flush_target(const FtBkState* st) {
  return ft_bk_oldest(st);
}

/** Persist the cursor every N records: a crash re-sends at most one window (server dedupes by sq). */
static const uint32_t FT_BK_CHECKPOINT_EVERY = 20;

static inline bool ft_bk_should_checkpoint(uint32_t records_since_checkpoint) {
  return records_since_checkpoint >= FT_BK_CHECKPOINT_EVERY;
}

// ----------------------------------------------------------------------------------------
// F-5 / F-2: record expiry. A record whose GPS time is older than the window is location
// data with no operational value — skip it on flush, purge it at boot. gts 0 = unknown
// (GPS time was not valid when stashed): treat as NOT expired (age can't be judged).
static const uint64_t FT_BK_MAX_AGE_MS = 6ULL * 3600ULL * 1000ULL; // matches the server's replay-trust window

static inline bool ft_bk_expired(uint64_t record_gts_ms, uint64_t now_gts_ms) {
  if (record_gts_ms == 0 || now_gts_ms == 0) return false;
  if (record_gts_ms >= now_gts_ms) return false;
  return (now_gts_ms - record_gts_ms) > FT_BK_MAX_AGE_MS;
}

// ----------------------------------------------------------------------------------------
// Reconnect backoff with jitter: base << attempt, capped, ±25% (rnd in [0,255]). Bounded so
// the device probes a dead AP gently, and jittered so a whole squad's trackers don't
// reconnect in lockstep when the AP comes back.
static inline uint32_t ft_backoff_ms(uint32_t attempt, uint32_t base_ms, uint32_t max_ms, uint8_t rnd) {
  uint32_t shift = attempt > 16 ? 16 : attempt;
  uint64_t d = (uint64_t)base_ms << shift;
  if (d > max_ms) d = max_ms;
  // jitter: d * (0.75 .. 1.25) — rnd/255 mapped onto [-25%, +25%]
  uint64_t j = (d * ((uint64_t)rnd * 50 / 255 + 75)) / 100;
  if (j < base_ms) j = base_ms;
  return (uint32_t)j;
}

// ----------------------------------------------------------------------------------------
// Tiny numeric extractor: find `"key":<digits>` in a JSON line WITHOUT a parser (the flush
// path reads its own records back — they were serialised by this same firmware, so the
// simple shape is guaranteed). Returns false when the key is absent or not followed by digits.
static inline bool ft_extract_u64(const char* line, const char* key, uint64_t* out) {
  const char* p = strstr(line, key);
  if (p == nullptr) return false;
  p += strlen(key);
  if (*p < '0' || *p > '9') return false;
  uint64_t v = 0;
  while (*p >= '0' && *p <= '9') {
    v = v * 10 + (uint64_t)(*p - '0');
    p++;
  }
  *out = v;
  return true;
}
