#include "test_framework.h"
#include "../include/agent_runtime.h"

TEST_CASE(test_agent_runtime_session_lifecycle) {
    AgentSession sess;
    agent_session_init(&sess, "test_session_1", ".", AUTONOMY_BALANCED, 5);

    ASSERT_EQ_STR(sess.session_id, "test_session_1");
    ASSERT_EQ_INT(sess.max_steps, 5);
    ASSERT_EQ_INT(sess.current_step, 0);

    bool ok1 = agent_session_add_message(&sess, ROLE_SYSTEM, "System initialized", NULL, NULL, false);
    ASSERT_TRUE(ok1);
    bool ok2 = agent_session_add_message(&sess, ROLE_USER, "Please inspect directory", NULL, NULL, false);
    ASSERT_TRUE(ok2);
    ASSERT_EQ_INT(sess.message_count, 2);

    agent_session_free(&sess);
    ASSERT_EQ_INT(sess.message_count, 0);
}

TEST_CASE(test_agent_step_budget_exhaustion) {
    AgentSession sess;
    agent_session_init(&sess, "test_budget", ".", AUTONOMY_BALANCED, 2);

    ToolResult res;
    bool ok1 = agent_session_execute_tool(&sess, "list_directory", ".", NULL, &res);
    ASSERT_TRUE(ok1);
    tool_result_free(&res);

    bool ok2 = agent_session_execute_tool(&sess, "list_directory", ".", NULL, &res);
    ASSERT_TRUE(ok2);
    tool_result_free(&res);

    /* 3rd step exceeds budget of 2 */
    bool ok3 = agent_session_execute_tool(&sess, "list_directory", ".", NULL, &res);
    ASSERT_FALSE(ok3);
    ASSERT_TRUE(sess.is_finished);
    ASSERT_CONTAINS(sess.finish_reason, "Max steps limit");
    tool_result_free(&res);

    agent_session_free(&sess);
}

TEST_CASE(test_agent_run_command_via_session) {
    AgentSession sess;
    agent_session_init(&sess, "test_cmd_exec", ".", AUTONOMY_BALANCED, 5);

    ToolResult res;
    /* run_command should work whether command is in path_arg or extra_arg */
    bool ok = agent_session_execute_tool(&sess, "run_command", "echo session_cmd_works", NULL, &res);
    ASSERT_TRUE(ok);
    ASSERT_CONTAINS(res.output, "session_cmd_works");
    tool_result_free(&res);

    agent_session_free(&sess);
}

void run_agent_runtime_tests(void) {
    printf("\n=== Running Agent Runtime & Session State Machine Tests ===\n");
    RUN_TEST(test_agent_runtime_session_lifecycle);
    RUN_TEST(test_agent_step_budget_exhaustion);
    RUN_TEST(test_agent_run_command_via_session);
}
