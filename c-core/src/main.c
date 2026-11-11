#include "../include/safety.h"
#include "../include/command_guard.h"
#include "../include/injection_detector.h"
#include "../include/loop_guard.h"
#include "../include/stream_processor.h"
#include "../include/tools.h"
#include "../include/agent_runtime.h"
#include "../include/json_rpc.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#include <shellapi.h>
#pragma comment(lib, "shell32.lib")
#endif

static void print_banner(void) {
    printf("========================================================\n");
    printf("        尚搏 Agent (Shangbo Agent) C-Core Engine        \n");
    printf("             Version: 0.9.4 (C Architecture)            \n");
    printf("========================================================\n\n");
}

static void on_text_chunk(const char *content, size_t len, void *user_data) {
    (void)user_data;
    printf("[TEXT]: %.*s\n", (int)len, content);
}

static void on_reasoning_chunk(const char *content, size_t len, void *user_data) {
    (void)user_data;
    printf("[THINK/REASONING]: %.*s\n", (int)len, content);
}

static void run_stream_demo(void) {
    printf("--- Running Stream Split-Tag Isolation Demo ---\n");
    StreamProcessor sp;
    stream_processor_init(&sp, on_text_chunk, on_reasoning_chunk, NULL);

    printf("Chunk 1: 'Prefix text <th'\n");
    stream_processor_feed(&sp, "Prefix text <th", 15);

    printf("Chunk 2: 'ink>internal reasoning thoughts</th'\n");
    stream_processor_feed(&sp, "ink>internal reasoning thoughts</th", 35);

    printf("Chunk 3: 'ink>final conclusion answer'\n");
    stream_processor_feed(&sp, "ink>final conclusion answer", 27);

    stream_processor_flush(&sp);
    printf("--- Stream Demo Complete ---\n\n");
}

static void run_repl(void) {
    printf("========================================================\n");
    printf("  进入 尚搏 Agent 交互控制台 (输入 'exit' 退出, 'help' 帮助) \n");
    printf("========================================================\n");
    printf("提示：\n");
    printf("  - 直接输入指令（如 git status）进行安全红线与注入审查\n");
    printf("  - 输入 :run <命令> 可直接受控执行安全命令\n");
    printf("  - 输入 :stream 演示大模型流式思考切分\n");
    printf("  - 输入 :audit <命令> 详细输出审计结果\n\n");

    AgentSession sess;
    agent_session_init(&sess, "repl_session", ".", AUTONOMY_BALANCED, 20);

    char line[1024];
    while (1) {
        printf("Agent> ");
        if (!fgets(line, sizeof(line), stdin)) break;
        size_t l = strlen(line);
        while (l > 0 && (line[l - 1] == '\n' || line[l - 1] == '\r')) line[--l] = '\0';
        if (strcmp(line, "exit") == 0 || strcmp(line, "quit") == 0) break;
        if (l == 0) continue;

        if (strcmp(line, "help") == 0 || strcmp(line, "?") == 0 || strcmp(line, ":help") == 0) {
            printf("\n可用交互指令：\n");
            printf("  :run <command>    - 执行命令（经过安全审计）\n");
            printf("  :audit <command>  - 查看命令安全审计详情\n");
            printf("  :stream           - 运行流式 <think> 标签隔离演示\n");
            printf("  exit / quit       - 退出控制台\n");
            printf("  <任意文本/命令>   - 快速审查安全性与提示词注入\n\n");
            continue;
        }

        if (strncmp(line, ":stream", 7) == 0) {
            run_stream_demo();
            continue;
        }

        if (strncmp(line, ":audit ", 7) == 0) {
            const char *cmd = line + 7;
            SafetyVerdict v = audit_hard_lines(cmd);
            printf("审计命令: %s\n", cmd);
            printf("安全等级: %s (分类: %s, 自动批准: %s)\n",
                   safety_tier_to_string(v.tier),
                   safety_category_to_string(v.category),
                   v.auto_approvable ? "YES" : "NO");
            if (v.reason[0]) printf("原因: %s\n", v.reason);
            bool safe = is_command_safe_for_auto_approval(cmd, ".");
            printf("守卫放行: %s\n\n", safe ? "ALLOWED" : "REJECTED/REQUIRES_CONFIRMATION");
            continue;
        }

        if (strncmp(line, ":run ", 5) == 0) {
            const char *cmd = line + 5;
            ToolResult res;
            bool ok = agent_session_execute_tool(&sess, "run_command", cmd, NULL, &res);
            if (ok) {
                printf("[执行成功]\n%s\n", res.output ? res.output : "");
            } else {
                printf("[执行被拒绝/失败]: %s\n", res.error_message);
            }
            tool_result_free(&res);
            continue;
        }

        /* 默认行为：检查注入与红线 */
        InjectionFinding f = scan_injection_rules(line);
        if (f.level == INJECTION_HIGH) {
            printf("[拦截] 检测到高危 Prompt 注入攻击: %s\n", f.reason);
            continue;
        }

        SafetyVerdict v = audit_hard_lines(line);
        if (v.tier == SAFETY_TIER_BLOCKED) {
            printf("[拦截] 触发安全红线 (永久禁止): %s\n", v.reason);
            continue;
        }
        if (v.tier == SAFETY_TIER_HARD) {
            printf("[警告] 触发破坏性敏感操作红线 (必须人工确认): %s\n", v.reason);
            continue;
        }

        printf("[审查通过] 等级: %s | 注入风险: %s | 自动放行: %s\n",
               safety_tier_to_string(v.tier),
               injection_level_to_string(f.level),
               v.auto_approvable ? "YES" : "NO");
    }

    agent_session_free(&sess);
    printf("\n会话已结束。\n");
#ifdef _WIN32
    printf("按回车键退出窗口...");
    getchar();
#endif
}

int main(int argc, char **argv) {
#ifdef _WIN32
    SetConsoleOutputCP(65001);
    SetConsoleCP(65001);

    int wargc = 0;
    LPWSTR *wargv = CommandLineToArgvW(GetCommandLineW(), &wargc);
    if (wargv) {
        char **utf8_argv = (char **)malloc(sizeof(char *) * (wargc + 1));
        if (utf8_argv) {
            for (int i = 0; i < wargc; ++i) {
                int len = WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, NULL, 0, NULL, NULL);
                utf8_argv[i] = (char *)malloc(len ? len : 1);
                if (utf8_argv[i]) {
                    WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, utf8_argv[i], len, NULL, NULL);
                }
            }
            utf8_argv[wargc] = NULL;
            argc = wargc;
            argv = utf8_argv;
        }
        LocalFree(wargv);
    }
#endif

    if (argc >= 2) {
        if (strcmp(argv[1], "rpc") == 0) {
            run_rpc_loop();
            return 0;
        }

        if (strcmp(argv[1], "--json") == 0) {
            if (argc < 3 || strcmp(argv[2], "ping") == 0) {
                handle_json_ping_cmd();
                return 0;
            }
            if (strcmp(argv[2], "audit") == 0) {
                handle_json_audit_cmd(argc >= 4 ? argv[3] : "");
                return 0;
            }
            if (strcmp(argv[2], "inject-check") == 0) {
                handle_json_inject_check_cmd(argc >= 4 ? argv[3] : "");
                return 0;
            }
            if (strcmp(argv[2], "is-safe") == 0) {
                handle_json_is_safe_cmd(argc >= 4 ? argv[3] : "", argc >= 5 ? argv[4] : ".");
                return 0;
            }
            if (strcmp(argv[2], "classify-tool") == 0) {
                handle_json_classify_tool_cmd(
                    argc >= 4 ? argv[3] : "",
                    argc >= 5 ? argv[4] : "",
                    argc >= 6 ? argv[5] : "",
                    argc >= 7 ? argv[6] : "balanced",
                    argc >= 8 ? argv[7] : "."
                );
                return 0;
            }
            if (strcmp(argv[2], "run-tool") == 0) {
                handle_json_run_tool_cmd(
                    argc >= 4 ? argv[3] : "",
                    argc >= 5 ? argv[4] : "",
                    argc >= 6 ? argv[5] : "",
                    argc >= 7 ? argv[6] : "",
                    argc >= 8 ? argv[7] : "."
                );
                return 0;
            }
            if (strcmp(argv[2], "detect-stuck") == 0) {
                int limit = argc >= 4 ? atoi(argv[3]) : 3;
                handle_json_detect_stuck_cmd(limit, argc >= 5 ? argv[4] : "[]");
                return 0;
            }
        }

        if (strcmp(argv[1], "audit") == 0 && argc >= 3 && strcmp(argv[2], "--json") == 0) {
            handle_json_audit_cmd(argc >= 4 ? argv[3] : "");
            return 0;
        }
        if (strcmp(argv[1], "inject-check") == 0 && argc >= 3 && strcmp(argv[2], "--json") == 0) {
            handle_json_inject_check_cmd(argc >= 4 ? argv[3] : "");
            return 0;
        }
    }

    print_banner();

    if (argc < 2) {
        /* 双击执行时无参数，默认直接进入交互式控制台，窗口保持打开 */
        run_repl();
        return 0;
    }

    const char *action = argv[1];

    if (strcmp(action, "-h") == 0 || strcmp(action, "--help") == 0 || strcmp(action, "help") == 0) {
        printf("Usage:\n");
        printf("  shangbo_agent.exe audit <command>\n");
        printf("  shangbo_agent.exe inject-check <text>\n");
        printf("  shangbo_agent.exe stream-demo\n");
        printf("  shangbo_agent.exe run-tool <tool_name> <path_or_arg> [extra_arg]\n");
        printf("  shangbo_agent.exe repl\n");
        return 0;
    }

    if (strcmp(action, "audit") == 0) {
        if (argc < 3) {
            printf("Error: Missing command to audit.\n");
            return 1;
        }
        const char *cmd = argv[2];
        printf("Auditing command: %s\n", cmd);

        SafetyVerdict v = audit_hard_lines(cmd);
        printf("Safety Tier: %s\n", safety_tier_to_string(v.tier));
        printf("Category:    %s\n", safety_category_to_string(v.category));
        printf("Auto-Approvable: %s\n", v.auto_approvable ? "YES" : "NO");
        if (v.reason[0]) {
            printf("Reason:      %s\n", v.reason);
        }

        bool safe_for_auto = is_command_safe_for_auto_approval(cmd, ".");
        printf("Command Guard Auto-Approval: %s\n", safe_for_auto ? "ALLOWED" : "REJECTED/REQUIRES_CONFIRMATION");
        return 0;
    }

    if (strcmp(action, "inject-check") == 0) {
        if (argc < 3) {
            printf("Error: Missing text for injection check.\n");
            return 1;
        }
        const char *text = argv[2];
        InjectionFinding f = scan_injection_rules(text);
        printf("Scan Text: %s\n", text);
        printf("Injection Level: %s\n", injection_level_to_string(f.level));
        printf("Reason: %s\n", f.reason);
        return 0;
    }

    if (strcmp(action, "stream-demo") == 0) {
        run_stream_demo();
        return 0;
    }

    if (strcmp(action, "run-tool") == 0) {
        if (argc < 3) {
            printf("Error: Missing tool name.\n");
            return 1;
        }
        const char *tool = argv[2];
        const char *arg1 = (argc >= 4) ? argv[3] : "";
        const char *arg2 = (argc >= 5) ? argv[4] : "";
        const char *arg3 = (argc >= 6) ? argv[5] : "";

        AgentSession sess;
        agent_session_init(&sess, "cli_session", ".", AUTONOMY_BALANCED, 10);

        ToolResult res;
        bool ok = false;
        if (strcmp(tool, "patch_file") == 0 && argc >= 6) {
            res = tool_patch_file(arg1, arg2, arg3, sess.workspace);
            ok = res.success;
        } else {
            ok = agent_session_execute_tool(&sess, tool, arg1, arg2, &res);
        }
        if (ok) {
            printf("Tool [%s] SUCCEEDED:\n%s\n", tool, res.output ? res.output : "(no output)");
        } else {
            printf("Tool [%s] FAILED: %s\n", tool, res.error_message);
        }
        tool_result_free(&res);
        agent_session_free(&sess);
        return ok ? 0 : 1;
    }

    if (strcmp(action, "repl") == 0) {
        run_repl();
        return 0;
    }

    printf("Unknown command: %s\n", action);
    return 1;
}
