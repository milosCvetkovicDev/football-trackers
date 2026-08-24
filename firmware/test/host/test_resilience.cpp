/**
 * Host-side tests for firmware/src/resilience.h — the Phase 4 crash-safety logic, run on the
 * development machine and in firmware CI (no hardware needed):
 *
 *   clang++ -std=c++17 -Wall -Wextra -Werror -I ../../src -o test_resilience test_resilience.cpp && ./test_resilience
 *
 * These are the properties the bench cannot easily prove (crash-window maths, rotation
 * decisions, id charset parity with the server) — the bench proves the I/O around them.
 */
#include "resilience.h"
#include <cstdio>
#include <cstdlib>
#include <string>

static int failures = 0;
#define CHECK(cond, msg)                                                     \
  do {                                                                       \
    if (!(cond)) {                                                           \
      std::printf("FAIL  %s  (%s:%d)\n", msg, __FILE__, __LINE__);           \
      failures++;                                                            \
    }                                                                        \
  } while (0)

static void test_id_valid() {
  CHECK(ft_id_valid("01"), "plain numeric id accepted");
  CHECK(ft_id_valid("A-b_c.9"), "full charset accepted");
  std::string max(64, 'a');
  CHECK(ft_id_valid(max.c_str()), "64-char id accepted");
  std::string over(65, 'a');
  CHECK(!ft_id_valid(over.c_str()), "65-char id rejected (buffer overflow vector)");
  CHECK(!ft_id_valid(""), "empty id rejected");
  CHECK(!ft_id_valid(nullptr), "null id rejected");
  CHECK(!ft_id_valid("07/b"), "id with '/' rejected — the audit's silent black hole (F-3)");
  CHECK(!ft_id_valid("07 b"), "id with a space rejected");
  CHECK(!ft_id_valid("07+b"), "id with '+' rejected (MQTT wildcard)");
  CHECK(!ft_id_valid("07#"), "id with '#' rejected (MQTT wildcard)");
  CHECK(!ft_id_valid("\xC3\xA9"), "non-ASCII id rejected");
}

static void test_seq() {
  // Boot resume: nothing below the stored high water may ever be reused.
  FtSeqState st = ft_seq_boot_resume(1000);
  CHECK(st.next == 1000, "resume starts AT the stored high water");
  CHECK(st.hw == 1000 + FT_SEQ_MARGIN, "a fresh ceiling is staged for persisting");
  uint32_t seq;
  bool persist = ft_seq_take(&st, &seq);
  CHECK(seq == 1000 && !persist, "first take uses the resume value, no persist needed yet");
  // Take up to the ceiling: crossing it must demand a persist BEFORE use.
  uint32_t persists = 0;
  uint32_t last = seq;
  for (uint32_t i = 0; i < FT_SEQ_MARGIN + 10; i++) {
    if (ft_seq_take(&st, &seq)) persists++;
    CHECK(seq == last + 1, "seq is strictly monotonic");
    CHECK(seq < st.hw, "seq always stays below the (to-be-)persisted ceiling");
    last = seq;
  }
  CHECK(persists == 1, "exactly one persist per margin window");
  // Crash property: resuming from ANY persisted hw yields values >= hw > every used seq.
  FtSeqState crashed = ft_seq_boot_resume(st.hw);
  uint32_t after;
  ft_seq_take(&crashed, &after);
  CHECK(after > last, "after a crash+resume, seqs continue above everything previously used");
}

static FtBkState mk(bool e0, uint32_t s0, uint32_t g0, bool e1, uint32_t s1, uint32_t g1, uint32_t ng) {
  FtBkState st;
  st.f[0] = { e0, s0, g0, 0 };
  st.f[1] = { e1, s1, g1, 0 };
  st.next_gen = ng;
  return st;
}

static void test_backlog_rotation() {
  const uint32_t CAP = 128 * 1024;
  // Empty: start file 0, fresh.
  FtBkState st = mk(false, 0, 0, false, 0, 0, 1);
  FtBkAppendPlan p = ft_bk_append_plan(&st, CAP);
  CHECK(p.target == 0 && p.start_fresh && !p.drop_oldest_at_target, "empty backlog starts file 0 fresh");
  CHECK(ft_bk_flush_target(&st) == -1, "nothing to flush when empty");
  // Room in the active file: keep appending.
  st = mk(true, 100, 1, false, 0, 0, 2);
  p = ft_bk_append_plan(&st, CAP);
  CHECK(p.target == 0 && !p.start_fresh, "append continues in the active file while it has room");
  // Active full, other slot empty: rotate WITHOUT dropping.
  st = mk(true, CAP, 1, false, 0, 0, 2);
  p = ft_bk_append_plan(&st, CAP);
  CHECK(p.target == 1 && p.start_fresh && !p.drop_oldest_at_target && p.new_gen == 2, "rotation to the empty slot drops nothing");
  // Both full: the OLDER half is dropped — and per the I/O contract it sits AT p.target, the slot
  // start_fresh recreates. The checker pass found main.cpp deleting `1 - target` (the NEWEST half,
  // then start_fresh removed the older one too — the entire backlog); these assertions pin the contract.
  st = mk(true, CAP, 3, true, CAP, 2, 4);
  p = ft_bk_append_plan(&st, CAP);
  CHECK(p.target == 1 && p.start_fresh && p.drop_oldest_at_target, "when both halves are full the OLDER one is dropped");
  CHECK(st.f[p.target].gen == 2, "the file being sacrificed is AT p.target (the lower generation)");
  CHECK(st.f[1 - p.target].gen == 3, "the slot NOT targeted holds the newest fixes — never delete it");
  // Flush drains the OLDEST generation first.
  st = mk(true, 500, 3, true, 400, 2, 4);
  CHECK(ft_bk_flush_target(&st) == 1, "flush picks the lowest generation");
  st = mk(true, 500, 3, false, 0, 0, 4);
  CHECK(ft_bk_flush_target(&st) == 0, "flush picks the only existing file");
  // Checkpoint cadence.
  CHECK(!ft_bk_should_checkpoint(FT_BK_CHECKPOINT_EVERY - 1), "no checkpoint before the window");
  CHECK(ft_bk_should_checkpoint(FT_BK_CHECKPOINT_EVERY), "checkpoint at the window");
}

static void test_expiry() {
  const uint64_t now = 1700000000000ULL;
  CHECK(!ft_bk_expired(now - 1000, now), "a fresh record is not expired");
  CHECK(!ft_bk_expired(now - FT_BK_MAX_AGE_MS, now), "a record AT the window is kept");
  CHECK(ft_bk_expired(now - FT_BK_MAX_AGE_MS - 1, now), "a record past the window is expired");
  CHECK(!ft_bk_expired(0, now), "gts 0 (GPS time unknown) cannot be judged — kept");
  CHECK(!ft_bk_expired(now - 1000, 0), "no current GPS time — kept");
  CHECK(!ft_bk_expired(now + 5000, now), "a future gts is not 'expired' (server distrusts it anyway)");
}

static void test_backoff() {
  // Bounded: never above max*1.25, never below base.
  for (uint32_t a = 0; a < 40; a++) {
    for (int r = 0; r <= 255; r += 51) {
      uint32_t d = ft_backoff_ms(a, 1000, 15000, (uint8_t)r);
      CHECK(d >= 1000, "backoff never below the base");
      CHECK(d <= 15000 + 15000 / 4, "backoff never above max +25% jitter");
    }
  }
  // Grows with attempts (at fixed jitter).
  CHECK(ft_backoff_ms(0, 1000, 15000, 128) < ft_backoff_ms(3, 1000, 15000, 128), "backoff grows");
  // Jitter actually varies the delay.
  CHECK(ft_backoff_ms(2, 1000, 15000, 0) != ft_backoff_ms(2, 1000, 15000, 255), "jitter varies with rnd");
  // Huge attempt values don't overflow into tiny delays.
  CHECK(ft_backoff_ms(1000, 1000, 15000, 128) >= 15000 * 3 / 4, "attempt overflow is clamped");
}

static void test_extract() {
  uint64_t v = 0;
  const char* line = "{\"id\":\"trk-01\",\"pl\":\"01\",\"sq\":4242,\"gts\":1700000000123,\"lat\":44.8}";
  CHECK(ft_extract_u64(line, "\"gts\":", &v) && v == 1700000000123ULL, "gts extracted");
  CHECK(ft_extract_u64(line, "\"sq\":", &v) && v == 4242, "sq extracted");
  CHECK(!ft_extract_u64(line, "\"nope\":", &v), "absent key is absent");
  CHECK(!ft_extract_u64("{\"gts\":\"12\"}", "\"gts\":", &v), "a quoted (non-numeric-position) value is rejected");
  CHECK(!ft_extract_u64("", "\"gts\":", &v), "empty line handled");
}

int main() {
  test_id_valid();
  test_seq();
  test_backlog_rotation();
  test_expiry();
  test_backoff();
  test_extract();
  if (failures > 0) {
    std::printf("\n%d FAILURE(S)\n", failures);
    return 1;
  }
  std::printf("all resilience.h host tests passed\n");
  return 0;
}
