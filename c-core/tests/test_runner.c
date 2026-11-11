#include "test_framework.h"

#ifdef _WIN32
#include <windows.h>
#endif

int g_tests_run = 0;
int g_tests_passed = 0;
int g_tests_failed = 0;

/* Forward declarations */
void run_safety_tests(void);
void run_command_guard_tests(void);
void run_injection_tests(void);
void run_stream_processor_tests(void);
void run_loop_guard_tests(void);
void run_tool_tests(void);
void run_agent_runtime_tests(void);
void run_json_rpc_tests(void);

int main(void) {
#ifdef _WIN32
    SetConsoleOutputCP(65001);
#endif
    printf("========================================================\n");
    printf("   尚搏 Agent (Shangbo Agent) C-Core Unified Test Suite \n");
    printf("========================================================\n");

    run_safety_tests();
    run_command_guard_tests();
    run_injection_tests();
    run_stream_processor_tests();
    run_loop_guard_tests();
    run_tool_tests();
    run_agent_runtime_tests();
    run_json_rpc_tests();

    PRINT_TEST_SUMMARY();

    return (g_tests_failed == 0) ? 0 : 1;
}
