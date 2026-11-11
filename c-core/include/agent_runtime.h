#ifndef SANGBO_AGENT_RUNTIME_H
#define SANGBO_AGENT_RUNTIME_H

#include "safety.h"
#include "loop_guard.h"
#include "stream_processor.h"
#include "tools.h"
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    ROLE_SYSTEM = 0,
    ROLE_USER,
    ROLE_ASSISTANT,
    ROLE_TOOL
} MessageRole;

typedef struct {
    MessageRole role;
    char *content;
    char tool_name[64];
    char tool_call_id[64];
    bool is_error;
} SessionMessage;

#define MAX_SESSION_MESSAGES 256

typedef struct {
    char session_id[64];
    char workspace[512];
    AutonomyLevel autonomy;
    int max_steps;
    int current_step;
    bool is_finished;
    char finish_reason[128];
    
    LoopGuard loop_guard;
    StreamProcessor stream_processor;
    
    SessionMessage messages[MAX_SESSION_MESSAGES];
    int message_count;
} AgentSession;

/* Initialize agent session with workspace and autonomy */
void agent_session_init(AgentSession *session, const char *session_id, const char *workspace, AutonomyLevel autonomy, int max_steps);

/* Free all dynamic message memory in session */
void agent_session_free(AgentSession *session);

/* Add a message to session history */
bool agent_session_add_message(AgentSession *session, MessageRole role, const char *content, const char *tool_name, const char *tool_call_id, bool is_error);

/* Execute one tool step with safety approval verification and loop checking */
bool agent_session_execute_tool(AgentSession *session, const char *tool_name, const char *path_arg, const char *extra_arg, ToolResult *out_result);

#ifdef __cplusplus
}
#endif

#endif /* SANGBO_AGENT_RUNTIME_H */
