#include "test_framework.h"
#include "../include/loop_guard.h"

TEST_CASE(test_loop_guard_healthy_flow) {
    LoopGuard lg;
    loop_guard_init(&lg, 3);

    loop_guard_record(&lg, "read_file", "path: A.txt", false);
    loop_guard_record(&lg, "patch_file", "path: A.txt", false);
    loop_guard_record(&lg, "run_command", "cmd: npm test", false);

    const char *stuck = loop_guard_check_stuck(&lg);
    ASSERT_TRUE(stuck == NULL);
}

TEST_CASE(test_loop_guard_consecutive_errors) {
    LoopGuard lg;
    loop_guard_init(&lg, 3);

    loop_guard_record(&lg, "patch_file", "path: A.txt", true);
    loop_guard_record(&lg, "patch_file", "path: A.txt", true);
    ASSERT_TRUE(loop_guard_check_stuck(&lg) == NULL);

    loop_guard_record(&lg, "patch_file", "path: A.txt", true);
    const char *stuck = loop_guard_check_stuck(&lg);
    ASSERT_TRUE(stuck != NULL);
    ASSERT_CONTAINS(stuck, "连续失败 3 次");
}

TEST_CASE(test_loop_guard_repetitive_identical_calls) {
    LoopGuard lg;
    loop_guard_init(&lg, 3);

    loop_guard_record(&lg, "read_file", "path: loop.txt", false);
    loop_guard_record(&lg, "read_file", "path: loop.txt", false);
    ASSERT_TRUE(loop_guard_check_stuck(&lg) == NULL);

    loop_guard_record(&lg, "read_file", "path: loop.txt", false);
    const char *stuck = loop_guard_check_stuck(&lg);
    ASSERT_TRUE(stuck != NULL);
    ASSERT_CONTAINS(stuck, "重复 3 次");
}

TEST_CASE(test_loop_guard_generation_result_polling_exempt) {
    LoopGuard lg;
    loop_guard_init(&lg, 3);

    /* 生图轮询：同 id 反复查询是正常等结果，不算打转 */
    loop_guard_record(&lg, "mcp__magpie-image__generation_result", "{\"id\":\"img_8a1b2a937fa26eab49b89b31\"}", false);
    loop_guard_record(&lg, "mcp__magpie-image__generation_result", "{\"id\":\"img_8a1b2a937fa26eab49b89b31\"}", false);
    loop_guard_record(&lg, "mcp__magpie-image__generation_result", "{\"id\":\"img_8a1b2a937fa26eab49b89b31\"}", false);
    ASSERT_TRUE(loop_guard_check_stuck(&lg) == NULL);

    /* 但连续报错仍要拦 */
    LoopGuard lg2;
    loop_guard_init(&lg2, 3);
    loop_guard_record(&lg2, "mcp__magpie-image__generation_result", "{\"id\":\"img_x\"}", true);
    loop_guard_record(&lg2, "mcp__magpie-image__generation_result", "{\"id\":\"img_x\"}", true);
    loop_guard_record(&lg2, "mcp__magpie-image__generation_result", "{\"id\":\"img_x\"}", true);
    ASSERT_TRUE(loop_guard_check_stuck(&lg2) != NULL);
}

void run_loop_guard_tests(void) {
    printf("\n=== Running Loop Guard & Deadlock Fuse Tests ===\n");
    RUN_TEST(test_loop_guard_healthy_flow);
    RUN_TEST(test_loop_guard_consecutive_errors);
    RUN_TEST(test_loop_guard_repetitive_identical_calls);
    RUN_TEST(test_loop_guard_generation_result_polling_exempt);
}
