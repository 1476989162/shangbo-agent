#include "test_framework.h"
#include "../include/safety.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#ifdef _WIN32
#include <direct.h>
#include <windows.h>
#else
#include <unistd.h>
#include <limits.h>
#include <sys/stat.h>
#endif

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
    SafetyVerdict echo_format = audit_hard_lines("echo format c:");
    ASSERT_EQ_INT(echo_format.tier, SAFETY_TIER_AUTO);
    SafetyVerdict filter = audit_hard_lines("git filter-branch --all");
    ASSERT_EQ_INT(filter.tier, SAFETY_TIER_HARD);
    SafetyVerdict kill = audit_hard_lines("taskkill /f /im example.exe");
    ASSERT_EQ_INT(kill.tier, SAFETY_TIER_HARD);
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
    ASSERT_TRUE(touches_private_data("cat .env.test"));
    ASSERT_TRUE(touches_private_data("cat .env.bak"));
    ASSERT_TRUE(touches_private_data("cat .env.ci"));
    ASSERT_TRUE(touches_private_data("del shangbo-agent.db"));
    ASSERT_TRUE(touches_private_data("copy test.db-wal /backup"));
    ASSERT_FALSE(touches_private_data("npm test"));
    ASSERT_FALSE(touches_private_data("git status"));
    /* .env.example / .env.sample / .env.template must NOT be false-positived */
    ASSERT_FALSE(touches_private_data(".env.example"));
    ASSERT_FALSE(touches_private_data("config/.env.sample"));
    ASSERT_FALSE(touches_private_data("cat .env.template"));

    /* Electron userData directory protection */
    safety_set_user_data_dir("C:/Users/TestUser/AppData/Roaming/shangbo-agent");
    ASSERT_TRUE(touches_private_data("C:\\Users\\TestUser\\AppData\\Roaming\\shangbo-agent\\config.json"));
    safety_set_user_data_dir("");
}

TEST_CASE(test_subagent_worktree_not_private_data) {
    /* Isolated subagent git worktrees live under %TEMP%\shangbo-subagent and must
       not be mistaken for the app's userData dir (regression: every read tool in
       an isolated subagent escalated to hard, run_command was blocked). */
    const char *worktree = "C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\shangbo-subagent\\subagent-a17fd014";
    ASSERT_FALSE(touches_private_data(worktree));
    ASSERT_FALSE(touches_private_data("C:\\Users\\TestUser\\AppData\\Local\\Temp\\shangbo-subagent\\subagent-1234abcd"));
    ASSERT_FALSE(touches_private_data("C:\\Users\\TestUser\\AppData\\Roaming\\shangbo-notes\\readme.txt"));

    /* Wildcard / env-var bypasses must still be caught */
    ASSERT_TRUE(touches_private_data("type %APPDATA%\\shangbo*\\secr*"));
    ASSERT_TRUE(touches_private_data("type C:\\Users\\x\\AppData\\Roaming\\shangbo*\\secr*"));
    ASSERT_TRUE(touches_private_data("dir %LOCALAPPDATA%\\shangbo*"));
    ASSERT_TRUE(touches_private_data("type $env:APPDATA\\shangbo*\\secr*"));

    SafetyContext ctx;
    memset(&ctx, 0, sizeof(ctx));
    strcpy(ctx.working_directory, worktree);
    ctx.autonomy = AUTONOMY_BALANCED;

    /* Read tools stay auto regardless of the listed path */
    SafetyVerdict vl = audit_tool_call("list_directory", ".", NULL, &ctx);
    ASSERT_EQ_INT(vl.tier, SAFETY_TIER_AUTO);
    ASSERT_TRUE(vl.auto_approvable);
    SafetyVerdict vh = audit_tool_call("list_directory", "C:\\Users\\Administrator", NULL, &ctx);
    ASSERT_EQ_INT(vh.tier, SAFETY_TIER_AUTO);
    SafetyVerdict vr = audit_tool_call("read_file", "src/main.c", NULL, &ctx);
    ASSERT_EQ_INT(vr.tier, SAFETY_TIER_AUTO);

    /* Commands are no longer permanently blocked inside the worktree */
    SafetyVerdict vc = audit_tool_call("run_command", NULL, "git status", &ctx);
    ASSERT_TRUE(vc.tier == SAFETY_TIER_AUTO || vc.tier == SAFETY_TIER_SOFT);
    ASSERT_TRUE(vc.category != CAT_PRIVATE_DATA);

    /* Writes inside the worktree are not private-data hard */
    SafetyVerdict vw = audit_tool_call("write_file", "src/new.c", NULL, &ctx);
    ASSERT_TRUE(vw.tier != SAFETY_TIER_HARD);
    ASSERT_TRUE(vw.category != CAT_PRIVATE_DATA);

    /* Real userData still hard for reads and blocked for commands */
    SafetyContext ud_ctx;
    memset(&ud_ctx, 0, sizeof(ud_ctx));
    strcpy(ud_ctx.working_directory, "C:\\Users\\TestUser\\AppData\\Roaming\\shangbo-agent");
    strcpy(ud_ctx.user_data_dir, "C:\\Users\\TestUser\\AppData\\Roaming\\shangbo-agent");
    ud_ctx.autonomy = AUTONOMY_BALANCED;
    SafetyVerdict vp = audit_tool_call("list_directory", ".", NULL, &ud_ctx);
    ASSERT_EQ_INT(vp.tier, SAFETY_TIER_HARD);
    ASSERT_FALSE(vp.auto_approvable);
    SafetyVerdict vpc = audit_tool_call("run_command", NULL, "git status", &ud_ctx);
    ASSERT_EQ_INT(vpc.tier, SAFETY_TIER_BLOCKED);
    safety_set_user_data_dir("");
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

    /* Relative path write when workspace is different from process cwd (and has trailing slash) */
    SafetyContext sub_ctx;
    memset(&sub_ctx, 0, sizeof(sub_ctx));
    strcpy(sub_ctx.working_directory, "G:/尚搏Agent/c-core/");
    sub_ctx.autonomy = AUTONOMY_BALANCED;
    SafetyVerdict vw_sub = audit_tool_call("write_file", "src/new_nested_target.c", NULL, &sub_ctx);
    ASSERT_EQ_INT(vw_sub.tier, SAFETY_TIER_AUTO);
    SafetyVerdict vw_sub_escape = audit_tool_call("write_file", "../outside_sub.c", NULL, &sub_ctx);
    ASSERT_EQ_INT(vw_sub_escape.tier, SAFETY_TIER_SOFT);

    /* Write outside workspace requires confirmation (soft tier) */
    SafetyVerdict vwo = audit_tool_call("write_file", "C:/Windows/temp.txt", NULL, &ctx);
    ASSERT_EQ_INT(vwo.tier, SAFETY_TIER_SOFT);

    /* Command run_command in strict mode requires soft approval */
    ctx.autonomy = AUTONOMY_STRICT;
    SafetyVerdict vc = audit_tool_call("run_command", NULL, "npm test", &ctx);
    ASSERT_EQ_INT(vc.tier, SAFETY_TIER_SOFT);
    ASSERT_FALSE(vc.auto_approvable);
}

/* Ticket 3：跨工作区递归/通配删除 → HARD；工作区内清理维持原策略。
 * 工作区取 %TEMP%/%TMPDIR% 下的真实 ASCII 目录（必须真实存在且可 stat）：
 * _getcwd 返回系统代码页字节，含中文时 CP_UTF8 解码失败，不能直接作工作区。 */
static void test_make_dirs(char *ws, size_t wcap, char *outside, size_t ocap) {
#ifdef _WIN32
    char tmp[MAX_PATH];
    DWORD n = GetTempPathA((DWORD)sizeof(tmp), tmp);
    if (n == 0 || n >= sizeof(tmp)) { strcpy_s(ws, wcap, "."); strcpy_s(outside, ocap, ".."); return; }
    _snprintf_s(ws, wcap, _TRUNCATE, "%sshangbo-wipe-ws", tmp);
    _snprintf_s(outside, ocap, _TRUNCATE, "%sshangbo-wipe-outside", tmp);
    CreateDirectoryA(ws, NULL);
    CreateDirectoryA(outside, NULL);
#else
    const char *base = getenv("TMPDIR");
    if (!base || !*base) base = "/tmp";
    snprintf(ws, wcap, "%s/shangbo-wipe-ws", base);
    snprintf(outside, ocap, "%s/shangbo-wipe-outside", base);
    mkdir(ws, 0755);
    mkdir(outside, 0755);
#endif
}

TEST_CASE(test_cross_workspace_recursive_wipe) {
    SafetyContext ctx;
    char ws[4096], outside[4096], cmd[8192];
    test_make_dirs(ws, sizeof(ws), outside, sizeof(outside));
    memset(&ctx, 0, sizeof(ctx));
    strncpy(ctx.working_directory, ws, sizeof(ctx.working_directory) - 1);
    ctx.autonomy = AUTONOMY_BALANCED;

    /* 区外真实目录 + 递归标志 → hard */
    snprintf(cmd, sizeof(cmd), "rd /s /q %s", outside);
    SafetyVerdict w1 = audit_tool_call("run_command", NULL, cmd, &ctx);
    ASSERT_EQ_INT(w1.tier, SAFETY_TIER_HARD);
    ASSERT_EQ_INT(w1.category, CAT_WORKSPACE);
    ASSERT_FALSE(w1.auto_approvable);

    /* 系统目录区外目标 → hard */
    /* outside 目录真实存在（test_make_dirs 创建），跨平台，无硬编码 */
    snprintf(cmd, sizeof(cmd), "rm -r %s", outside);
    SafetyVerdict w2 = audit_tool_call("run_command", NULL, cmd, &ctx);
    ASSERT_EQ_INT(w2.tier, SAFETY_TIER_HARD);

    /* .. 相对逃逸的递归删除 → hard（纯字符串判定，不依赖文件系统） */
    SafetyVerdict w3 = audit_tool_call("run_command", NULL, "rm -rf ../other-project", &ctx);
    ASSERT_EQ_INT(w3.tier, SAFETY_TIER_HARD);

    /* 引号包裹的 .. 逃逸也拦（剥引号后再判） */
    SafetyVerdict w3q = audit_tool_call("run_command", NULL, "rm -rf \"../quoted-escape\"", &ctx);
    ASSERT_EQ_INT(w3q.tier, SAFETY_TIER_HARD);
    SafetyVerdict w3q2 = audit_tool_call("run_command", NULL, "rm -rf '../quoted-escape2'", &ctx);
    ASSERT_EQ_INT(w3q2.tier, SAFETY_TIER_HARD);

    /* 引号包裹的绝对区外路径也拦 */
    snprintf(cmd, sizeof(cmd), "rm -rf \"%s\"", outside);
    SafetyVerdict w3q3 = audit_tool_call("run_command", NULL, cmd, &ctx);
    ASSERT_EQ_INT(w3q3.tier, SAFETY_TIER_HARD);

#ifndef _WIN32
    /* Unix /tmp/... 回归：/tmp 恒存在且在任何工作区之外 */
    SafetyVerdict wu = audit_tool_call("run_command", NULL, "rm -rf /tmp/wipe-me-test", &ctx);
    ASSERT_EQ_INT(wu.tier, SAFETY_TIER_HARD);
#endif

    /* 工作区内子目录递归清理：维持原策略不升 hard（不因本票收紧而误伤） */
    snprintf(cmd, sizeof(cmd), "rm -r %s/obj", ws);
    SafetyVerdict w4 = audit_tool_call("run_command", NULL, cmd, &ctx);
    ASSERT_TRUE(w4.tier != SAFETY_TIER_HARD);

    /* 单文件删除（无递归无通配）不受影响 */
    snprintf(cmd, sizeof(cmd), "del %s/tmp.txt", ws);
    SafetyVerdict w5 = audit_tool_call("run_command", NULL, cmd, &ctx);
    ASSERT_TRUE(w5.tier != SAFETY_TIER_HARD);
    /* 清理本用例创建的 tmp 目录（空目录，直接删） */
#ifdef _WIN32
    RemoveDirectoryA(ws);
    RemoveDirectoryA(outside);
#else
    rmdir(ws);
    rmdir(outside);
#endif
}

/* Ticket 3：multi_patch_file 纳入写盘工具分级 */
TEST_CASE(test_multi_patch_file_classification) {
    SafetyContext ctx;
    char ws[4096], outside[4096];
    test_make_dirs(ws, sizeof(ws), outside, sizeof(outside));
    memset(&ctx, 0, sizeof(ctx));
    strncpy(ctx.working_directory, ws, sizeof(ctx.working_directory) - 1);
    ctx.autonomy = AUTONOMY_BALANCED;
    char target[8192];

    /* multi_patch_file 与 write_file 同级：工作区内 auto（相对路径，不依赖代码页） */
    SafetyVerdict v1 = audit_tool_call("multi_patch_file", "src/tools.c", NULL, &ctx);
    ASSERT_EQ_INT(v1.tier, SAFETY_TIER_AUTO);

    /* 工作区外：soft 需确认（与 patch_file 一致） */
    SafetyVerdict v2 = audit_tool_call("multi_patch_file", "../outside.ts", NULL, &ctx);
    ASSERT_EQ_INT(v2.tier, SAFETY_TIER_SOFT);

    /* 私有数据路径：hard（文件名匹配，与路径无关） */
    SafetyVerdict v3 = audit_tool_call("multi_patch_file", "secrets.json", NULL, &ctx);
    ASSERT_EQ_INT(v3.tier, SAFETY_TIER_HARD);
    ASSERT_EQ_INT(v3.category, CAT_PRIVATE_DATA);

    /* 区外绝对路径：soft（用本用例的 tmp 目录，跨平台） */
    snprintf(target, sizeof(target), "%s/other.ts", outside);
    SafetyVerdict v4 = audit_tool_call("multi_patch_file", target, NULL, &ctx);
    ASSERT_EQ_INT(v4.tier, SAFETY_TIER_SOFT);
#ifdef _WIN32
    RemoveDirectoryA(ws);
    RemoveDirectoryA(outside);
#else
    rmdir(ws);
    rmdir(outside);
#endif
}

/* Ticket 3-Item1 回归：rpc_task_execute 依赖的 TLS 语义：
 * safety_set_user_data_dir 写入即生效（本线程隔离），
 * 传空字符串即清空（任务结束必须清，否则线程复用时残留上个请求的私有目录）。 */
TEST_CASE(test_user_data_dir_tls_set_clear) {
    safety_set_user_data_dir("C:/Users/someone/appdata-test");
    ASSERT_TRUE(touches_private_data("C:/Users/someone/appdata-test/config.json"));
    safety_set_user_data_dir("");
    ASSERT_FALSE(touches_private_data("C:/Users/someone/appdata-test/config.json"));
}

void run_safety_tests(void) {
    printf("\n=== Running Safety & Security Guard Tests ===\n");
    RUN_TEST(test_disk_blockers_permanent);
    RUN_TEST(test_git_hard_redlines);
    RUN_TEST(test_database_hard_redlines);
    RUN_TEST(test_commit_message_quotes_not_blocked);
    RUN_TEST(test_nested_interpreter_redlines);
    RUN_TEST(test_private_data_guard);
    RUN_TEST(test_subagent_worktree_not_private_data);
    RUN_TEST(test_workspace_boundary_check);
    RUN_TEST(test_tool_call_safety_audit);
    RUN_TEST(test_cross_workspace_recursive_wipe);
    RUN_TEST(test_multi_patch_file_classification);
    RUN_TEST(test_user_data_dir_tls_set_clear);
}
