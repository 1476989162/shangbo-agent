#include "test_framework.h"
#include "../include/safety.h"

TEST_CASE(test_disk_blockers_permanent) {
    SafetyVerdict v1 = audit_hard_lines("format c:");
    ASSERT_EQ_INT(v1.tier, SAFETY_TIER_BLOCKED);
    ASSERT_EQ_INT(v1.category, CAT_DISK);
    ASSERT_FALSE(v1.auto_approvable);

    SafetyVerdict v2 = audit_hard_lines("diskpart /s script.txt");
    ASSERT_EQ_INT(v2.tier, SAFETY_TIER_BLOCKED);

    SafetyVerdict v3 = audit_hard_lines("dd if=/dev/zero of=/dev/sda bs=1M");
    ASSERT_EQ_INT(v3.tier, SAFETY_TIER_BLOCKED);

    SafetyVerdict v4 = audit_hard_lines("rm -rf /");
    ASSERT_EQ_INT(v4.tier, SAFETY_TIER_BLOCKED);

    SafetyVerdict v5 = audit_hard_lines("del /s /q c:\\*");
    ASSERT_EQ_INT(v5.tier, SAFETY_TIER_BLOCKED);
}

TEST_CASE(test_git_hard_redlines) {
    SafetyVerdict v1 = audit_hard_lines("rm -rf .git");
    ASSERT_EQ_INT(v1.tier, SAFETY_TIER_HARD);
    ASSERT_EQ_INT(v1.category, CAT_GIT);

    SafetyVerdict v2 = audit_hard_lines("git push origin main --force");
    ASSERT_EQ_INT(v2.tier, SAFETY_TIER_HARD);

    SafetyVerdict v3 = audit_hard_lines("git reset --hard HEAD~1");
    ASSERT_EQ_INT(v3.tier, SAFETY_TIER_HARD);

    SafetyVerdict v4 = audit_hard_lines("git clean -fdx");
    ASSERT_EQ_INT(v4.tier, SAFETY_TIER_HARD);

    SafetyVerdict v5 = audit_hard_lines("git branch -D feat-branch");
    ASSERT_EQ_INT(v5.tier, SAFETY_TIER_HARD);
}

TEST_CASE(test_database_hard_redlines) {
    SafetyVerdict v1 = audit_hard_lines("DROP TABLE users;");
    ASSERT_EQ_INT(v1.tier, SAFETY_TIER_HARD);
    ASSERT_EQ_INT(v1.category, CAT_DATABASE);

    SafetyVerdict v2 = audit_hard_lines("TRUNCATE TABLE orders;");
    ASSERT_EQ_INT(v2.tier, SAFETY_TIER_HARD);

    SafetyVerdict v3 = audit_hard_lines("DELETE FROM accounts;");
    ASSERT_EQ_INT(v3.tier, SAFETY_TIER_HARD);

    /* DELETE with WHERE should NOT be hard redline */
    SafetyVerdict v4 = audit_hard_lines("DELETE FROM accounts WHERE id = 123;");
    ASSERT_EQ_INT(v4.tier, SAFETY_TIER_AUTO);

    /* Deleting sqlite file */
    SafetyVerdict v5 = audit_hard_lines("rm main.sqlite3");
    ASSERT_EQ_INT(v5.tier, SAFETY_TIER_HARD);
}

TEST_CASE(test_commit_message_quotes_not_blocked) {
    /* Commit message containing 'drop database' should not trigger redline */
    SafetyVerdict v = audit_hard_lines("git commit -m \"fix: prevent drop database bug\"");
    ASSERT_EQ_INT(v.tier, SAFETY_TIER_AUTO);
}

TEST_CASE(test_nested_interpreter_redlines) {
    /* Quotes inside interpreter commands must NOT be stripped and must trigger redlines */
    SafetyVerdict v1 = audit_hard_lines("powershell -c \"format c:\"");
    ASSERT_EQ_INT(v1.tier, SAFETY_TIER_BLOCKED);
    ASSERT_FALSE(v1.auto_approvable);

    SafetyVerdict v2 = audit_hard_lines("cmd /c \"rmdir /s /q .git\"");
    ASSERT_EQ_INT(v2.tier, SAFETY_TIER_HARD);
    ASSERT_FALSE(v2.auto_approvable);

    SafetyVerdict v3 = audit_hard_lines("node -e \"DROP TABLE users;\"");
    ASSERT_EQ_INT(v3.tier, SAFETY_TIER_HARD);
    ASSERT_FALSE(v3.auto_approvable);

    /* Encoded commands must be treated as unanalyzable and require hard confirmation */
    SafetyVerdict v4 = audit_hard_lines("powershell -enc aW52b2tl");
    ASSERT_EQ_INT(v4.tier, SAFETY_TIER_HARD);
    ASSERT_FALSE(v4.auto_approvable);
}

TEST_CASE(test_private_data_guard) {
    ASSERT_TRUE(touches_private_data("type %APPDATA%\\shangbo-agent\\secrets.json"));
    ASSERT_TRUE(touches_private_data("cat ~/.ssh/id_rsa"));
    ASSERT_TRUE(touches_private_data("cp .env /tmp"));
    ASSERT_TRUE(touches_private_data("cat .env.local"));
    ASSERT_TRUE(touches_private_data("del shangbo-agent.db"));
    ASSERT_TRUE(touches_private_data("copy test.db-wal /backup"));
    ASSERT_FALSE(touches_private_data("npm test"));
    ASSERT_FALSE(touches_private_data("git status"));
}

TEST_CASE(test_workspace_boundary_check) {
    ASSERT_TRUE(is_path_inside_workspace("src/main.c", "G:/尚搏Agent"));
    ASSERT_TRUE(is_path_inside_workspace("G:/尚搏Agent/src/main.c", "G:/尚搏Agent"));
    ASSERT_FALSE(is_path_inside_workspace("../outside.txt", "G:/尚搏Agent"));
    ASSERT_FALSE(is_path_inside_workspace("G:/尚搏Agent/../outside.txt", "G:/尚搏Agent"));
    ASSERT_FALSE(is_path_inside_workspace("G:\\尚搏Agent\\..\\outside.txt", "G:/尚搏Agent"));
    ASSERT_FALSE(is_path_inside_workspace("C:/Windows/System32/cmd.exe", "G:/尚搏Agent"));
}

TEST_CASE(test_tool_call_safety_audit) {
    SafetyContext ctx;
    memset(&ctx, 0, sizeof(ctx));
    strcpy(ctx.working_directory, "G:/尚搏Agent");
    ctx.autonomy = AUTONOMY_BALANCED;

    /* Read tools auto-approved */
    SafetyVerdict vr = audit_tool_call("read_file", "src/main.c", NULL, &ctx);
    ASSERT_EQ_INT(vr.tier, SAFETY_TIER_AUTO);

    /* Read secrets blocked/hard */
    SafetyVerdict vs = audit_tool_call("read_file", "secrets.json", NULL, &ctx);
    ASSERT_EQ_INT(vs.tier, SAFETY_TIER_HARD);

    /* Write inside workspace auto-approved in balanced mode */
    SafetyVerdict vw = audit_tool_call("write_file", "src/main.c", NULL, &ctx);
    ASSERT_EQ_INT(vw.tier, SAFETY_TIER_AUTO);

    /* Write outside workspace requires confirmation (soft tier) */
    SafetyVerdict vwo = audit_tool_call("write_file", "C:/Windows/temp.txt", NULL, &ctx);
    ASSERT_EQ_INT(vwo.tier, SAFETY_TIER_SOFT);

    /* Command run_command in strict mode requires soft approval */
    ctx.autonomy = AUTONOMY_STRICT;
    SafetyVerdict vc = audit_tool_call("run_command", NULL, "npm test", &ctx);
    ASSERT_EQ_INT(vc.tier, SAFETY_TIER_SOFT);
    ASSERT_FALSE(vc.auto_approvable);
}

void run_safety_tests(void) {
    printf("\n=== Running Safety & Security Guard Tests ===\n");
    RUN_TEST(test_disk_blockers_permanent);
    RUN_TEST(test_git_hard_redlines);
    RUN_TEST(test_database_hard_redlines);
    RUN_TEST(test_commit_message_quotes_not_blocked);
    RUN_TEST(test_nested_interpreter_redlines);
    RUN_TEST(test_private_data_guard);
    RUN_TEST(test_workspace_boundary_check);
    RUN_TEST(test_tool_call_safety_audit);
}
