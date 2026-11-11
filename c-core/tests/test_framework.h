#ifndef SANGBO_AGENT_TEST_FRAMEWORK_H
#define SANGBO_AGENT_TEST_FRAMEWORK_H

#include <stdio.h>
#include <string.h>
#include <stdbool.h>

extern int g_tests_run;
extern int g_tests_passed;
extern int g_tests_failed;

#define TEST_CASE(name) void name(void)

#define RUN_TEST(func) do { \
    g_tests_run++; \
    printf("  [RUN]  %s\n", #func); \
    int before_failed = g_tests_failed; \
    func(); \
    if (g_tests_failed == before_failed) { \
        g_tests_passed++; \
        printf("  [PASS] %s\n", #func); \
    } else { \
        printf("  [FAIL] %s\n", #func); \
    } \
} while (0)

#define ASSERT_TRUE(cond) do { \
    if (!(cond)) { \
        printf("    ASSERTION FAILED (%s:%d): %s is not true\n", __FILE__, __LINE__, #cond); \
        g_tests_failed++; \
        return; \
    } \
} while (0)

#define ASSERT_FALSE(cond) do { \
    if ((cond)) { \
        printf("    ASSERTION FAILED (%s:%d): %s is not false\n", __FILE__, __LINE__, #cond); \
        g_tests_failed++; \
        return; \
    } \
} while (0)

#define ASSERT_EQ_INT(a, b) do { \
    int _va = (int)(a); \
    int _vb = (int)(b); \
    if (_va != _vb) { \
        printf("    ASSERTION FAILED (%s:%d): %d != %d\n", __FILE__, __LINE__, _va, _vb); \
        g_tests_failed++; \
        return; \
    } \
} while (0)

#define ASSERT_EQ_STR(a, b) do { \
    const char *_sa = (a); \
    const char *_sb = (b); \
    if (!_sa || !_sb || strcmp(_sa, _sb) != 0) { \
        printf("    ASSERTION FAILED (%s:%d): \"%s\" != \"%s\"\n", __FILE__, __LINE__, _sa ? _sa : "(null)", _sb ? _sb : "(null)"); \
        g_tests_failed++; \
        return; \
    } \
} while (0)

#define ASSERT_CONTAINS(haystack, needle) do { \
    const char *_h = (haystack); \
    const char *_n = (needle); \
    if (!_h || !_n || strstr(_h, _n) == NULL) { \
        printf("    ASSERTION FAILED (%s:%d): \"%s\" not found in \"%s\"\n", __FILE__, __LINE__, _n ? _n : "(null)", _h ? _h : "(null)"); \
        g_tests_failed++; \
        return; \
    } \
} while (0)

#define PRINT_TEST_SUMMARY() do { \
    printf("\n============================================\n"); \
    printf("Test Results: %d run, %d passed, %d failed\n", g_tests_run, g_tests_passed, g_tests_failed); \
    printf("============================================\n"); \
} while (0)

#endif /* SANGBO_AGENT_TEST_FRAMEWORK_H */
