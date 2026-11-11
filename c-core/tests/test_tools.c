#include "test_framework.h"
#include "../include/tools.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
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
    ASSERT_EQ_STR(r_res.output, test_content);
    tool_result_free(&r_res);

    /* 3. Read specific line range (line 2 to 2) */
    ToolResult r_line = tool_read_file(test_path, 2, 2, ".");
    ASSERT_TRUE(r_line.success);
    ASSERT_EQ_STR(r_line.output, "Line 2: C Core Refactored\n");
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
    ASSERT_EQ_STR(read_res.output, "nested hello");
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

void run_tool_tests(void) {
    printf("\n=== Running Tools Execution & Security Gate Tests ===\n");
    RUN_TEST(test_tool_file_lifecycle);
    RUN_TEST(test_tool_write_nested_directory);
    RUN_TEST(test_tool_search_files_security);
    RUN_TEST(test_tool_private_data_rejection);
    RUN_TEST(test_tool_list_directory);
    RUN_TEST(test_tool_run_command_safe);
    RUN_TEST(test_tool_run_command_redline_blocked);
}
