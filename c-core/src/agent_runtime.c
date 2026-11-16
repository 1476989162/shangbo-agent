#include "../include/agent_runtime.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#define STRDUP _strdup
#else
#define STRDUP strdup
#endif

void agent_session_init(AgentSession *session, const char *session_id, const char *workspace, AutonomyLevel autonomy, int max_steps) {
    if (!session) return;
    memset(session, 0, sizeof(AgentSession));

    if (session_id) {
        strncpy(session->session_id, session_id, sizeof(session->session_id) - 1);
    } else {
        snprintf(session->session_id, sizeof(session->session_id), "sess_default");
    }

    if (workspace) {
        strncpy(session->workspace, workspace, sizeof(session->workspace) - 1);
    }

    session->autonomy = autonomy;
    session->max_steps = (max_steps > 0) ? max_steps : 25;
    session->current_step = 0;
    session->is_finished = false;

    loop_guard_init(&session->loop_guard, 3);
}

void agent_session_free(AgentSession *session) {
    if (!session) return;
    for (int i = 0; i < session->message_count; ++i) {
        if (session->messages[i].content) {
            free(session->messages[i].content);
            session->messages[i].content = NULL;
        }
    }
    session->message_count = 0;
}

bool agent_session_add_message(AgentSession *session, MessageRole role, const char *content, const char *tool_name, const char *tool_call_id, bool is_error) {
    if (!session || session->message_count >= MAX_SESSION_MESSAGES) return false;

    SessionMessage *msg = &session->messages[session->message_count++];
    msg->role = role;
    msg->is_error = is_error;
    if (content) {
        msg->content = STRDUP(content);
    } else {
        msg->content = STRDUP("");
    }
    if (tool_name) {
        strncpy(msg->tool_name, tool_name, sizeof(msg->tool_name) - 1);
    }
    if (tool_call_id) {
        strncpy(msg->tool_call_id, tool_call_id, sizeof(msg->tool_call_id) - 1);
    }
    return true;
}

bool agent_session_execute_tool_ex(AgentSession *session, const char *tool_name, const char *path_arg, const char *extra_arg, const char *third_arg, ToolResult *out_result) {
    if (!session || !tool_name || !out_result) return false;

    memset(out_result, 0, sizeof(ToolResult));

    /* 1. Step budget check */
    if (session->current_step >= session->max_steps) {
        session->is_finished = true;
        snprintf(session->finish_reason, sizeof(session->finish_reason), "Max steps limit (%d) reached.", session->max_steps);
        snprintf(out_result->error_message, sizeof(out_result->error_message), "Agent budget exhausted: max steps reached.");
        return false;
    }

    /* 2. Loop guard check before execution */
    const char *stuck_reason = loop_guard_check_stuck(&session->loop_guard);
    if (stuck_reason) {
        session->is_finished = true;
        snprintf(session->finish_reason, sizeof(session->finish_reason), "%s", stuck_reason);
        snprintf(out_result->error_message, sizeof(out_result->error_message), "LoopGuard tripped: %s", stuck_reason);
        return false;
    }

    session->current_step++;

    /* 3. Safety tier check */
    SafetyContext s_ctx;
    memset(&s_ctx, 0, sizeof(s_ctx));
    strncpy(s_ctx.working_directory, session->workspace, sizeof(s_ctx.working_directory) - 1);
    s_ctx.autonomy = session->autonomy;

    SafetyVerdict v = audit_tool_call(tool_name, path_arg, extra_arg, &s_ctx);
    if (v.tier == SAFETY_TIER_BLOCKED) {
        snprintf(out_result->error_message, sizeof(out_result->error_message), "BLOCKED: %s", v.reason);
        loop_guard_record(&session->loop_guard, tool_name, path_arg ? path_arg : extra_arg, true);
        return false;
    }
    if (v.tier == SAFETY_TIER_HARD) {
        snprintf(out_result->error_message, sizeof(out_result->error_message), "HARD_APPROVAL: %s", v.reason);
        loop_guard_record(&session->loop_guard, tool_name, path_arg ? path_arg : extra_arg, true);
        return false;
    }

    /* 4. Dispatch tool */
    if (strcmp(tool_name, "read_file") == 0) {
        int start = (extra_arg && *extra_arg) ? atoi(extra_arg) : 0;
        int end = (third_arg && *third_arg) ? atoi(third_arg) : (start > 0 ? -1 : 0);
        *out_result = tool_read_file(path_arg, start, end, session->workspace);
    } else if (strcmp(tool_name, "write_file") == 0) {
        *out_result = tool_write_file(path_arg, extra_arg, true, session->workspace);
    } else if (strcmp(tool_name, "patch_file") == 0) {
        if (third_arg != NULL) {
            *out_result = tool_patch_file(path_arg, extra_arg ? extra_arg : "", third_arg, session->workspace);
        } else if (extra_arg && strstr(extra_arg, "=>") != NULL) {
            const char *delim = strstr(extra_arg, "=>");
            size_t tlen = (size_t)(delim - extra_arg);
            char *target_buf = (char *)malloc(tlen + 1);
            if (target_buf) {
                memcpy(target_buf, extra_arg, tlen);
                target_buf[tlen] = '\0';
                *out_result = tool_patch_file(path_arg, target_buf, delim + 2, session->workspace);
                free(target_buf);
            } else {
                snprintf(out_result->error_message, sizeof(out_result->error_message), "Out of memory.");
                out_result->success = false;
            }
        } else {
            snprintf(out_result->error_message, sizeof(out_result->error_message), "Replacement content is required for patch_file.");
            out_result->success = false;
        }
    } else if (strcmp(tool_name, "list_directory") == 0) {
        *out_result = tool_list_directory(path_arg, 2, session->workspace);
    } else if (strcmp(tool_name, "search_files") == 0) {
        *out_result = tool_search_files(path_arg, extra_arg, session->workspace);
    } else if (strcmp(tool_name, "run_command") == 0) {
        const char *cmd_to_run = (extra_arg && *extra_arg) ? extra_arg : path_arg;
        *out_result = tool_run_command(cmd_to_run, session->workspace, &s_ctx);
    } else {
        snprintf(out_result->error_message, sizeof(out_result->error_message), "Unknown tool: %s", tool_name);
        out_result->success = false;
    }

    /* 5. Record result in loop guard and session messages */
    loop_guard_record(&session->loop_guard, tool_name, path_arg ? path_arg : extra_arg, !out_result->success);

    char call_id[32];
    snprintf(call_id, sizeof(call_id), "call_%d", session->current_step);
    agent_session_add_message(session, ROLE_TOOL,
                              out_result->success ? out_result->output : out_result->error_message,
                              tool_name, call_id, !out_result->success);

    return out_result->success;
}

bool agent_session_execute_tool(AgentSession *session, const char *tool_name, const char *path_arg, const char *extra_arg, ToolResult *out_result) {
    return agent_session_execute_tool_ex(session, tool_name, path_arg, extra_arg, NULL, out_result);
}
