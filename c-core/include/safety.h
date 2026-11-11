#ifndef SANGBO_AGENT_SAFETY_H
#define SANGBO_AGENT_SAFETY_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    SAFETY_TIER_AUTO = 0,
    SAFETY_TIER_SOFT = 1,
    SAFETY_TIER_HARD = 2,
    SAFETY_TIER_BLOCKED = 3
} SafetyTier;

typedef enum {
    CAT_DISK = 0,
    CAT_GIT,
    CAT_DATABASE,
    CAT_SYSTEM,
    CAT_PRIVATE_DATA,
    CAT_WORKSPACE,
    CAT_EXTERNAL,
    CAT_READ
} SafetyCategory;

typedef enum {
    AUTONOMY_STRICT = 0,
    AUTONOMY_BALANCED = 1,
    AUTONOMY_TRUSTED = 2
} AutonomyLevel;

typedef struct {
    SafetyTier tier;
    SafetyCategory category;
    char reason[256];
    bool auto_approvable;
} SafetyVerdict;

typedef struct {
    char working_directory[512];
    AutonomyLevel autonomy;
} SafetyContext;

/* Core Safety Inspection APIs */
SafetyVerdict audit_hard_lines(const char *command);
bool is_path_inside_workspace(const char *target_path, const char *workspace);
bool touches_private_data(const char *path_or_command);
SafetyVerdict audit_tool_call(const char *tool_name, const char *path_arg, const char *command_arg, const SafetyContext *ctx);

const char *safety_tier_to_string(SafetyTier tier);
const char *safety_category_to_string(SafetyCategory category);

#ifdef __cplusplus
}
#endif

#endif /* SANGBO_AGENT_SAFETY_H */
