#include "test_framework.h"
#include "../include/tools.h"
#include "../include/native_process.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#include <direct.h>
#else
#include <unistd.h>
#endif

TEST_CASE(test_tool_file_lifecycle) {
    const char *test_path = "test_temp_file.txt";
    const char *test_content = "Line 1: Hello Shangbo\nLine 2: C Core Refactored\nLine 3: High Performance\n";

    /* 1. Write file */
    ToolResult w_res = tool_write_file(test_path, test_content, true, ".");
    ASSERT_TRUE(w_res.success);
    tool_result_free(&w_res);

    /* 2. Read full file */
    ToolResult r_res = tool_read_file(test_path, 0, 0, ".");
    ASSERT_TRUE(r_res.success);
    ASSERT_CONTAINS(r_res.output, test_content);
    tool_result_free(&r_res);

    /* 3. Read specific line range (line 2 to 2) */
    ToolResult r_line = tool_read_file(test_path, 2, 2, ".");
    ASSERT_TRUE(r_line.success);
    ASSERT_CONTAINS(r_line.output, "2: Line 2: C Core Refactored");
    tool_result_free(&r_line);

    /* 4. Patch file */
    ToolResult p_res = tool_patch_file(test_path, "High Performance", "Ultra Fast Engine", ".");
    ASSERT_TRUE(p_res.success);
    tool_result_free(&p_res);

    /* 5. Verify patched content */
    ToolResult r_verify = tool_read_file(test_path, 0, 0, ".");
    ASSERT_TRUE(r_verify.success);
    ASSERT_CONTAINS(r_verify.output, "Ultra Fast Engine");
    tool_result_free(&r_verify);

    /* Cleanup */
    remove(test_path);
}

TEST_CASE(test_tool_write_nested_directory) {
    /* tool_write_file must automatically create intermediate parent directories */
    const char *nested_path = "temp_test_dir/sub/nested_file.txt";
    ToolResult res = tool_write_file(nested_path, "nested hello", true, ".");
    ASSERT_TRUE(res.success);
    tool_result_free(&res);

    ToolResult read_res = tool_read_file(nested_path, 0, 0, ".");
    ASSERT_TRUE(read_res.success);
    ASSERT_CONTAINS(read_res.output, "nested hello");
    tool_result_free(&read_res);

    /* Cleanup */
    remove(nested_path);
#ifdef _WIN32
    _rmdir("temp_test_dir/sub");
    _rmdir("temp_test_dir");
#else
    rmdir("temp_test_dir/sub");
    rmdir("temp_test_dir");
#endif
}

TEST_CASE(test_tool_search_files_security) {
    /* Injection attempt in search query must be rejected */
    ToolResult res_inj = tool_search_files(".", "foo\" & calc & \"", ".");
    ASSERT_FALSE(res_inj.success);
    ASSERT_CONTAINS(res_inj.error_message, "shell metacharacters not allowed");
    tool_result_free(&res_inj);

    /* Private credential search must be rejected */
    ToolResult res_priv = tool_search_files(".", "password", ".");
    /* Searching secrets.json target */
    ToolResult res_priv2 = tool_search_files("secrets.json", "key", ".");
    ASSERT_FALSE(res_priv2.success);
    ASSERT_CONTAINS(res_priv2.error_message, "Access denied");
    tool_result_free(&res_priv2);

    /* Normal search for main */
    ToolResult res_ok = tool_search_files("src", "main", ".");
    ASSERT_TRUE(res_ok.success);
    tool_result_free(&res_ok);
}

TEST_CASE(test_tool_private_data_rejection) {
    ToolResult w_sec = tool_write_file("secrets.json", "leaked", true, ".");
    ASSERT_FALSE(w_sec.success);
    ASSERT_CONTAINS(w_sec.error_message, "Security rejection");
    tool_result_free(&w_sec);

    ToolResult r_sec = tool_read_file(".ssh/id_rsa", 0, 0, ".");
    ASSERT_FALSE(r_sec.success);
    ASSERT_CONTAINS(r_sec.error_message, "Access denied");
    tool_result_free(&r_sec);
}

TEST_CASE(test_tool_list_directory) {
    ToolResult l_res = tool_list_directory(".", 1, ".");
    ASSERT_TRUE(l_res.success);
    ASSERT_TRUE(l_res.output_len > 0);
    ASSERT_CONTAINS(l_res.output, "[DIR]");
    tool_result_free(&l_res);
}

TEST_CASE(test_tool_run_command_safe) {
    SafetyContext s_ctx;
    memset(&s_ctx, 0, sizeof(s_ctx));
    s_ctx.autonomy = AUTONOMY_BALANCED;

    ToolResult cmd_res = tool_run_command("echo c_core_agent_alive", ".", &s_ctx);
    ASSERT_TRUE(cmd_res.success);
    ASSERT_CONTAINS(cmd_res.output, "c_core_agent_alive");
    tool_result_free(&cmd_res);
}

TEST_CASE(test_tool_run_command_redline_blocked) {
    SafetyContext s_ctx;
    memset(&s_ctx, 0, sizeof(s_ctx));
    s_ctx.autonomy = AUTONOMY_TRUSTED; /* Even trusted mode cannot bypass */

    ToolResult cmd_res = tool_run_command("format d:", ".", &s_ctx);
    ASSERT_FALSE(cmd_res.success);
    ASSERT_CONTAINS(cmd_res.error_message, "BLOCKED");
    tool_result_free(&cmd_res);
}

TEST_CASE(test_tool_read_windows_and_ranges) {
    const char *path = "test_contract_read.txt";
    ToolResult w = tool_write_file(path, "first\nsecond\nthird\n", true, ".");
    ASSERT_TRUE(w.success);
    tool_result_free(&w);
    ToolResult line = tool_read_file(path, 2, 2, ".");
    ASSERT_TRUE(line.success);
    ASSERT_CONTAINS(line.output, "2: second");
    tool_result_free(&line);
    ToolResult range = tool_read_file(path, 99, 100, ".");
    ASSERT_FALSE(range.success);
    tool_result_free(&range);
    ToolResult bytes = tool_read_file_window(path, 6, 6, ".");
    ASSERT_TRUE(bytes.success);
    ASSERT_CONTAINS(bytes.output, "second");
    tool_result_free(&bytes);
    remove(path);
}

TEST_CASE(test_tool_patch_requires_unique_anchor) {
    const char *path = "test_unique_patch.txt";
    ToolResult w = tool_write_file(path, "same\nsame\n", true, ".");
    ASSERT_TRUE(w.success);
    tool_result_free(&w);
    ToolResult duplicate = tool_patch_file(path, "same", "changed", ".");
    ASSERT_FALSE(duplicate.success);
    ASSERT_CONTAINS(duplicate.error_message, "not unique");
    tool_result_free(&duplicate);
    ToolResult unique = tool_patch_file(path, "same\nsame", "changed", ".");
    ASSERT_TRUE(unique.success);
    tool_result_free(&unique);
    ToolResult read = tool_read_file(path, 0, 0, ".");
    ASSERT_CONTAINS(read.output, "changed");
    tool_result_free(&read);
    remove(path);
}

TEST_CASE(test_tool_patch_crlf_anchor) {
    const char *path = "test_crlf_patch.txt";
    ToolResult w = tool_write_file(path, "one\r\ntwo\r\nthree\r\n", true, ".");
    ASSERT_TRUE(w.success);
    tool_result_free(&w);
    ToolResult patch = tool_patch_file(path, "two\nthree", "TWO\nTHREE", ".");
    ASSERT_TRUE(patch.success);
    tool_result_free(&patch);
    ToolResult read = tool_read_file(path, 0, 0, ".");
    ASSERT_TRUE(read.success);
    ASSERT_CONTAINS(read.output, "(17 bytes):\n\none\r\nTWO\r\nTHREE\r\n");
    tool_result_free(&read);

    /* Single-line target on CRLF file with multi-line LF replacement must also preserve CRLF */
    ToolResult patch2 = tool_patch_file(path, "TWO", "TWO_A\nTWO_B", ".");
    ASSERT_TRUE(patch2.success);
    tool_result_free(&patch2);
    ToolResult read2 = tool_read_file(path, 0, 0, ".");
    ASSERT_TRUE(read2.success);
    ASSERT_CONTAINS(read2.output, "(26 bytes):\n\none\r\nTWO_A\r\nTWO_B\r\nTHREE\r\n");
    tool_result_free(&read2);
    remove(path);
}

TEST_CASE(test_tool_unicode_command_working_directory) {
#ifdef _WIN32
    const char *dir = "test_\xe4\xb8\xad\xe6\x96\x87_dir";
    wchar_t *wide = NULL;
    int len = MultiByteToWideChar(CP_UTF8, 0, dir, -1, NULL, 0);
    wide = (wchar_t *)malloc((size_t)len * sizeof(wchar_t));
    ASSERT_TRUE(wide != NULL);
    MultiByteToWideChar(CP_UTF8, 0, dir, -1, wide, len);
    _wmkdir(wide);
    free(wide);
    SafetyContext ctx; memset(&ctx, 0, sizeof(ctx));
    strncpy(ctx.working_directory, dir, sizeof(ctx.working_directory) - 1);
    ctx.autonomy = AUTONOMY_BALANCED;
    ToolResult run = tool_run_command_ex("echo c_unicode_ok", dir, &ctx, 10000);
    ASSERT_TRUE(run.success);
    ASSERT_CONTAINS(run.output, "c_unicode_ok\r\n");
    tool_result_free(&run);
    len = MultiByteToWideChar(CP_UTF8, 0, dir, -1, NULL, 0);
    wide = (wchar_t *)malloc((size_t)len * sizeof(wchar_t));
    MultiByteToWideChar(CP_UTF8, 0, dir, -1, wide, len);
    _wrmdir(wide);
    free(wide);
#endif
}

TEST_CASE(test_tool_native_search_filename_and_content) {
    const char *dir = "test_native_search";
    const char *path = "test_native_search/needle.txt";
    ToolResult w = tool_write_file(path, "alpha\nbeta native_search_needle\n", true, ".");
    ASSERT_TRUE(w.success);
    tool_result_free(&w);
    ToolResult name = tool_search_files_ex(dir, "needle", NULL, 10, ".");
    ASSERT_TRUE(name.success);
    ASSERT_CONTAINS(name.output, "needle.txt");
    tool_result_free(&name);
    ToolResult content = tool_search_files_ex(dir, NULL, "native_search_needle", 10, ".");
    ASSERT_TRUE(content.success);
    ASSERT_CONTAINS(content.output, "needle.txt:2: beta native_search_needle");
    tool_result_free(&content);
    ToolResult both_hit = tool_search_files_ex(dir, "needle", "native_search_needle", 10, ".");
    ASSERT_TRUE(both_hit.success);
    ASSERT_CONTAINS(both_hit.output, "needle.txt:2: beta native_search_needle");
    tool_result_free(&both_hit);
    ToolResult both_miss = tool_search_files_ex(dir, "nonexistent_name", "native_search_needle", 10, ".");
    ASSERT_TRUE(both_miss.success);
    ASSERT_CONTAINS(both_miss.output, "Found 0 matches");
    tool_result_free(&both_miss);
    remove(path);
#ifdef _WIN32
    _rmdir(dir);
#else
    rmdir(dir);
#endif
}

TEST_CASE(test_tool_guidance_and_nonzero_exit_and_approval) {
    const char *empty_path = "test_empty_file.txt";
    ToolResult w = tool_write_file(empty_path, "", true, ".");
    ASSERT_TRUE(w.success);
    tool_result_free(&w);

    /* Reading empty file without line numbers succeeds */
    ToolResult r_empty = tool_read_file(empty_path, 0, 0, ".");
    ASSERT_TRUE(r_empty.success);
    ASSERT_CONTAINS(r_empty.output, "(0 bytes):");
    tool_result_free(&r_empty);

    /* Calling read_file on a directory guides caller to list_directory */
    ToolResult r_dir = tool_read_file("src", 0, 0, ".");
    ASSERT_FALSE(r_dir.success);
    ASSERT_CONTAINS(r_dir.error_message, "list_directory");
    tool_result_free(&r_dir);

    /* Calling list_directory on a file guides caller to read_file */
    ToolResult l_file = tool_list_directory(empty_path, 2, ".");
    ASSERT_FALSE(l_file.success);
    ASSERT_CONTAINS(l_file.error_message, "read_file");
    tool_result_free(&l_file);

    /* Non-zero exit code preserves output and returns success = true */
    SafetyContext ctx;
    memset(&ctx, 0, sizeof(ctx));
    ctx.autonomy = AUTONOMY_BALANCED;
    ToolResult nz = tool_run_command("echo nonzero_detail_kept && exit /b 3", ".", &ctx);
    ASSERT_TRUE(nz.success);
    ASSERT_CONTAINS(nz.output, "--- exit code 3 ---");
    ASSERT_CONTAINS(nz.output, "nonzero_detail_kept");
    tool_result_free(&nz);

    /* Hard redline without approval is rejected, with approved=true passes gate */
    ToolResult unapproved = tool_run_command("taskkill /f /im non_existent_dummy_proc_12345.exe", ".", &ctx);
    ASSERT_FALSE(unapproved.success);
    ASSERT_CONTAINS(unapproved.error_message, "HARD_APPROVAL_REQUIRED");
    tool_result_free(&unapproved);

    ctx.approved = true;
    ToolResult approved = tool_run_command("taskkill /f /im non_existent_dummy_proc_12345.exe", ".", &ctx);
    ASSERT_TRUE(approved.success);
    ASSERT_CONTAINS(approved.output, "--- exit code");
    tool_result_free(&approved);

    remove(empty_path);
}

#ifdef _WIN32
static DWORD WINAPI cancel_after_delay(void *argument) {
    Sleep(100);
    *((volatile long *)argument) = 1;
    return 0;
}
#endif

TEST_CASE(test_tool_native_timeout_and_cancellation) {
    SafetyContext ctx; memset(&ctx, 0, sizeof(ctx)); ctx.autonomy = AUTONOMY_BALANCED;
#ifdef _WIN32
    ToolResult timeout = tool_run_command_ex("ping 127.0.0.1 -n 10 >nul", ".", &ctx, 100);
    ASSERT_FALSE(timeout.success);
    ASSERT_CONTAINS(timeout.error_message, "timed out");
    tool_result_free(&timeout);
    volatile long cancel = 0;
    HANDLE canceller = CreateThread(NULL, 0, cancel_after_delay, (void *)&cancel, 0, NULL);
    ASSERT_TRUE(canceller != NULL);
    DWORD started = GetTickCount();
    ToolResult cancelled = tool_run_command_cancellable("ping 127.0.0.1 -n 10 >nul", ".", &ctx, 10000, &cancel);
    WaitForSingleObject(canceller, INFINITE);
    CloseHandle(canceller);
    ASSERT_FALSE(cancelled.success);
    ASSERT_CONTAINS(cancelled.error_message, "cancelled");
    ASSERT_TRUE(GetTickCount() - started < 5000);
    tool_result_free(&cancelled);
#endif
}

void run_tool_tests(void) {
    printf("\n=== Running Tools Execution & Security Gate Tests ===\n");
    RUN_TEST(test_tool_file_lifecycle);
    RUN_TEST(test_tool_write_nested_directory);
    RUN_TEST(test_tool_search_files_security);
    RUN_TEST(test_tool_private_data_rejection);
    RUN_TEST(test_tool_list_directory);
    RUN_TEST(test_tool_run_command_safe);
    RUN_TEST(test_tool_run_command_redline_blocked);
    RUN_TEST(test_tool_read_windows_and_ranges);
    RUN_TEST(test_tool_patch_requires_unique_anchor);
    RUN_TEST(test_tool_patch_crlf_anchor);
    RUN_TEST(test_tool_unicode_command_working_directory);
    RUN_TEST(test_tool_native_search_filename_and_content);
    RUN_TEST(test_tool_guidance_and_nonzero_exit_and_approval);
    RUN_TEST(test_tool_native_timeout_and_cancellation);
}
