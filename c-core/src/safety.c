#include "../include/safety.h"
#include "../include/command_guard.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

#ifdef _WIN32
#include <windows.h>
#endif

/* Case-insensitive string search helper */
static const char *strcasestr_custom(const char *haystack, const char *needle) {
    if (!haystack || !needle) return NULL;
    if (!*needle) return haystack;
    for (; *haystack; ++haystack) {
        if (tolower((unsigned char)*haystack) == tolower((unsigned char)*needle)) {
            const char *h = haystack;
            const char *n = needle;
            while (*h && *n && tolower((unsigned char)*h) == tolower((unsigned char)*n)) {
                ++h;
                ++n;
            }
            if (!*n) return haystack;
        }
    }
    return NULL;
}

/* Helper to check if a word boundary precedes and succeeds a token */
static bool match_word_token(const char *str, const char *token) {
    const char *pos = strcasestr_custom(str, token);
    while (pos) {
        bool left_boundary = (pos == str) || isspace((unsigned char)*(pos - 1)) ||
                             *(pos - 1) == ';' || *(pos - 1) == '&' || *(pos - 1) == '|' ||
                             *(pos - 1) == '(' || *(pos - 1) == '"' || *(pos - 1) == '\'';
        const char *after = pos + strlen(token);
        bool right_boundary = (*after == '\0') || isspace((unsigned char)*after) ||
                              *after == ';' || *after == '&' || *after == '|' ||
                              *after == ')' || *after == '"' || *after == '\'' ||
                              *after == '/' || *after == '\\';
        if (left_boundary && right_boundary) return true;
        pos = strcasestr_custom(pos + 1, token);
    }
    return false;
}

const char *safety_tier_to_string(SafetyTier tier) {
    switch (tier) {
        case SAFETY_TIER_AUTO: return "auto";
        case SAFETY_TIER_SOFT: return "soft";
        case SAFETY_TIER_HARD: return "hard";
        case SAFETY_TIER_BLOCKED: return "blocked";
        default: return "unknown";
    }
}

const char *safety_category_to_string(SafetyCategory category) {
    switch (category) {
        case CAT_DISK: return "disk";
        case CAT_GIT: return "git";
        case CAT_DATABASE: return "database";
        case CAT_SYSTEM: return "system";
        case CAT_PRIVATE_DATA: return "private-data";
        case CAT_WORKSPACE: return "workspace";
        case CAT_EXTERNAL: return "external";
        case CAT_READ: return "read";
        default: return "unknown";
    }
}

bool touches_private_data(const char *path_or_command) {
    if (!path_or_command) return false;
    if (strcasestr_custom(path_or_command, "secrets.json")) return true;
    if (strcasestr_custom(path_or_command, "shangbo-agent.db")) return true;
    if (strcasestr_custom(path_or_command, ".db-wal") || strcasestr_custom(path_or_command, ".db-shm") ||
        strcasestr_custom(path_or_command, ".db-journal")) return true;
    if (strcasestr_custom(path_or_command, ".ssh\\") || strcasestr_custom(path_or_command, ".ssh/")) return true;
    if (match_word_token(path_or_command, ".ssh")) return true;
    if (strcasestr_custom(path_or_command, ".aws\\") || strcasestr_custom(path_or_command, ".aws/")) return true;
    if (match_word_token(path_or_command, ".aws")) return true;
    if (strcasestr_custom(path_or_command, "id_rsa") || strcasestr_custom(path_or_command, "id_ed25519")) return true;
    if (strcasestr_custom(path_or_command, ".env")) return true;
    return false;
}

/* Detects whether command is an interpreter or database client that takes inline code inside quotes */
static bool is_quoted_code_host(const char *command) {
    if (!command) return false;
    while (*command && isspace((unsigned char)*command)) command++;
    static const char *hosts[] = {
        "powershell", "pwsh", "cmd", "bash", "sh", "zsh", "perl", "ruby", "php",
        "python", "python3", "node", "mysql", "mariadb", "psql", "sqlite", "sqlite3",
        "sqlcmd", "osql", "mongo", "mongosh", "redis-cli", NULL
    };
    char first_word[64];
    size_t i = 0;
    while (command[i] && !isspace((unsigned char)command[i]) && i + 1 < sizeof(first_word)) {
        first_word[i] = (char)tolower((unsigned char)command[i]);
        i++;
    }
    first_word[i] = '\0';
    char *dot = strrchr(first_word, '.');
    if (dot && (strcmp(dot, ".exe") == 0 || strcmp(dot, ".cmd") == 0 || strcmp(dot, ".bat") == 0)) {
        *dot = '\0';
    }
    for (int k = 0; hosts[k]; ++k) {
        if (strcmp(first_word, hosts[k]) == 0) return true;
    }
    return false;
}

/* Strips quoted string literals ("..." and '...') to avoid false positives in commit messages */
static void strip_quotes(const char *src, char *dst, size_t dst_size) {
    size_t d = 0;
    bool in_single = false;
    bool in_double = false;
    for (size_t s = 0; src[s] && d + 1 < dst_size; ++s) {
        char c = src[s];
        if (c == '\'' && !in_double) {
            in_single = !in_single;
            continue;
        }
        if (c == '"' && !in_single) {
            in_double = !in_double;
            continue;
        }
        if (!in_single && !in_double) {
            dst[d++] = c;
        }
    }
    dst[d] = '\0';
}

/* Checks if a path token in a delete command represents an entire drive or root wipe */
static bool is_root_wipe_target(const char *cmd) {
    if (!cmd) return false;
    for (const char *p = cmd; *p; ++p) {
        bool left = (p == cmd) || isspace((unsigned char)*(p - 1)) || *(p - 1) == '"' || *(p - 1) == '\'';
        if (!left) continue;

        /* Match "/" or "/*" as standalone target, avoiding Windows switches like "/s", "/q", "/c" */
        if (*p == '/') {
            if (*(p + 1) == '\0' || isspace((unsigned char)*(p + 1)) || *(p + 1) == '"' || *(p + 1) == '\'') {
                return true;
            }
            if (*(p + 1) == '*' && (*(p + 2) == '\0' || isspace((unsigned char)*(p + 2)) || *(p + 2) == '"' || *(p + 2) == '\'')) {
                return true;
            }
        }
        /* Match "~/*" */
        if (*p == '~' && *(p + 1) == '/' && *(p + 2) == '*' &&
            (*(p + 3) == '\0' || isspace((unsigned char)*(p + 3)) || *(p + 3) == '"' || *(p + 3) == '\'')) {
            return true;
        }
        /* Match drive root like "C:\" or "C:\*" or "C:/*" */
        if (isalpha((unsigned char)*p) && p[1] == ':' && (p[2] == '\\' || p[2] == '/')) {
            if (p[3] == '*' && (*(p + 4) == '\0' || isspace((unsigned char)*(p + 4)) || *(p + 4) == '"' || *(p + 4) == '\'')) {
                return true;
            }
            if (*(p + 3) == '\0' || isspace((unsigned char)*(p + 3)) || *(p + 3) == '"' || *(p + 3) == '\'') {
                return true;
            }
        }
    }
    return false;
}

SafetyVerdict audit_hard_lines(const char *command) {
    SafetyVerdict v;
    memset(&v, 0, sizeof(v));
    v.tier = SAFETY_TIER_AUTO;
    v.auto_approvable = true;

    if (!command || !*command) return v;

    /* When executing via interpreter (powershell, cmd, node, etc.), quotes contain executable code and cannot be stripped */
    char cleaned[4096];
    if (is_quoted_code_host(command)) {
        strncpy(cleaned, command, sizeof(cleaned) - 1);
        cleaned[sizeof(cleaned) - 1] = '\0';
    } else {
        strip_quotes(command, cleaned, sizeof(cleaned));
    }

    /* 0. UNANALYZABLE ENCODED / DYNAMIC EVALUATION COMMANDS */
    if (strcasestr_custom(command, "-enc ") || strcasestr_custom(command, "-encodedcommand") ||
        strcasestr_custom(command, "iex ") || strcasestr_custom(command, "invoke-expression") ||
        strcasestr_custom(command, "invoke-webrequest") || strcasestr_custom(command, "iwr ")) {
        v.tier = SAFETY_TIER_HARD;
        v.category = CAT_SYSTEM;
        v.auto_approvable = false;
        snprintf(v.reason, sizeof(v.reason), "检测到编码执行或动态表达式求值（-enc/iex/invoke-expression）：无法静态审计，必须人工确认。");
        return v;
    }

    /* 1. DISK BLOCKERS (Permanent Block) */
    if (strcasestr_custom(cleaned, "format ") || strcasestr_custom(cleaned, "diskpart") ||
        strcasestr_custom(cleaned, "mkfs") || strcasestr_custom(cleaned, "fdisk") ||
        strcasestr_custom(cleaned, "parted") || strcasestr_custom(cleaned, "wipefs") ||
        strcasestr_custom(cleaned, "bcdedit /delete") || strcasestr_custom(cleaned, "vssadmin delete") ||
        strcasestr_custom(cleaned, "cipher /w")) {
        v.tier = SAFETY_TIER_BLOCKED;
        v.category = CAT_DISK;
        v.auto_approvable = false;
        snprintf(v.reason, sizeof(v.reason), "检测到磁盘格式化/分区/擦盘类操作：这是永久禁止的红线，任何模式下都不会执行。");
        return v;
    }

    /* Raw disk device write: echo x > /dev/sda or of=/dev/ */
    if (strcasestr_custom(command, "/dev/sd") || strcasestr_custom(command, "/dev/hd") ||
        strcasestr_custom(command, "/dev/nvme") || strcasestr_custom(command, "of=/dev/")) {
        if (strcasestr_custom(command, ">") || strcasestr_custom(command, "dd ") || strcasestr_custom(command, "shred ")) {
            v.tier = SAFETY_TIER_BLOCKED;
            v.category = CAT_DISK;
            v.auto_approvable = false;
            snprintf(v.reason, sizeof(v.reason), "检测到直接写入磁盘设备：这是永久禁止的红线，任何模式下都不会执行。");
            return v;
        }
    }

    /* Root wipe: rm -rf / or rm -rf C:\ or del /s /q C:\* */
    bool is_delete = match_word_token(cleaned, "rm") || match_word_token(cleaned, "rmdir") ||
                     match_word_token(cleaned, "rd") || match_word_token(cleaned, "del") ||
                     match_word_token(cleaned, "erase") || match_word_token(cleaned, "remove-item");
    if (is_delete && is_root_wipe_target(cleaned)) {
        v.tier = SAFETY_TIER_BLOCKED;
        v.category = CAT_DISK;
        v.auto_approvable = false;
        snprintf(v.reason, sizeof(v.reason), "检测到对根目录或整盘的通配删除：这是永久禁止的红线，任何模式下都不会执行。");
        return v;
    }

    /* 2. GIT HARD REDLINES */
    bool is_move = match_word_token(cleaned, "mv") || match_word_token(cleaned, "move") ||
                    match_word_token(cleaned, "move-item") || match_word_token(cleaned, "ren");
    if ((is_delete || is_move) && (strcasestr_custom(cleaned, ".git\\") || strcasestr_custom(cleaned, ".git/") ||
                                   match_word_token(cleaned, ".git"))) {
        v.tier = SAFETY_TIER_HARD;
        v.category = CAT_GIT;
        v.auto_approvable = false;
        snprintf(v.reason, sizeof(v.reason), "检测到删除或移动 .git 仓库目录：会丢失全部提交历史，必须人工确认。");
        return v;
    }

    if (strcasestr_custom(cleaned, "git push") && (strcasestr_custom(cleaned, "--force") || match_word_token(cleaned, "-f"))) {
        v.tier = SAFETY_TIER_HARD;
        v.category = CAT_GIT;
        v.auto_approvable = false;
        snprintf(v.reason, sizeof(v.reason), "检测到 git push --force 强推操作：会重写远端历史，必须人工确认。");
        return v;
    }

    if (strcasestr_custom(cleaned, "git reset") && strcasestr_custom(cleaned, "--hard")) {
        v.tier = SAFETY_TIER_HARD;
        v.category = CAT_GIT;
        v.auto_approvable = false;
        snprintf(v.reason, sizeof(v.reason), "检测到 git reset --hard 操作：会彻底丢弃未提交改动，必须人工确认。");
        return v;
    }

    if (strcasestr_custom(cleaned, "git clean") && strcasestr_custom(cleaned, "-f")) {
        v.tier = SAFETY_TIER_HARD;
        v.category = CAT_GIT;
        v.auto_approvable = false;
        snprintf(v.reason, sizeof(v.reason), "检测到 git clean -f 强制清理未跟踪文件：必须人工确认。");
        return v;
    }

    if (strcasestr_custom(cleaned, "git branch") && strcasestr_custom(cleaned, "-D")) {
        v.tier = SAFETY_TIER_HARD;
        v.category = CAT_GIT;
        v.auto_approvable = false;
        snprintf(v.reason, sizeof(v.reason), "检测到 git branch -D 强删分支：必须人工确认。");
        return v;
    }

    /* 3. DATABASE HARD REDLINES */
    if (strcasestr_custom(cleaned, "drop database") || strcasestr_custom(cleaned, "drop table") ||
        strcasestr_custom(cleaned, "drop schema") || strcasestr_custom(cleaned, "truncate table") ||
        strcasestr_custom(cleaned, "dropdatabase(") || strcasestr_custom(cleaned, "flushall") ||
        strcasestr_custom(cleaned, "flushdb") || strcasestr_custom(cleaned, "dropdb")) {
        v.tier = SAFETY_TIER_HARD;
        v.category = CAT_DATABASE;
        v.auto_approvable = false;
        snprintf(v.reason, sizeof(v.reason), "检测到删库/清表/删除表结构类操作：必须人工确认。");
        return v;
    }

    /* DELETE FROM without WHERE */
    if (strcasestr_custom(cleaned, "delete from ") && !strcasestr_custom(cleaned, "where")) {
        v.tier = SAFETY_TIER_HARD;
        v.category = CAT_DATABASE;
        v.auto_approvable = false;
        snprintf(v.reason, sizeof(v.reason), "检测到没有 WHERE 条件的 DELETE（会清空整张表）：必须人工确认。");
        return v;
    }

    /* Deleting/moving database files (.db, .sqlite, .mdf) */
    if (is_delete || is_move) {
        if (strcasestr_custom(cleaned, ".db") || strcasestr_custom(cleaned, ".sqlite") ||
            strcasestr_custom(cleaned, ".sqlite3") || strcasestr_custom(cleaned, ".mdf")) {
            v.tier = SAFETY_TIER_HARD;
            v.category = CAT_DATABASE;
            v.auto_approvable = false;
            snprintf(v.reason, sizeof(v.reason), "检测到删除或移动数据库文件：按删库同级处理，必须人工确认。");
            return v;
        }
    }

    /* 4. SYSTEM BLOCKERS */
    if (strcasestr_custom(cleaned, "reg delete hk") || strcasestr_custom(cleaned, "shutdown") ||
        strcasestr_custom(cleaned, "reboot")) {
        v.tier = SAFETY_TIER_BLOCKED;
        v.category = CAT_SYSTEM;
        v.auto_approvable = false;
        snprintf(v.reason, sizeof(v.reason), "检测到系统关机/重启/删除注册表等高危系统操作：禁止自动执行。");
        return v;
    }

    return v;
}

/* Helper to normalize path slashes to '/' */
static void normalize_path(const char *in, char *out, size_t out_size) {
    size_t i = 0;
    for (; in[i] && i + 1 < out_size; ++i) {
        out[i] = (in[i] == '\\') ? '/' : (char)tolower((unsigned char)in[i]);
    }
    out[i] = '\0';
    /* Remove trailing slash if length > 1 */
    if (i > 1 && out[i - 1] == '/') {
        out[i - 1] = '\0';
    }
}

bool is_path_inside_workspace(const char *target_path, const char *workspace) {
    if (!target_path || !workspace || !*target_path || !*workspace) return false;

    char norm_target[1024];
    char norm_ws[1024];
    normalize_path(target_path, norm_target, sizeof(norm_target));
    normalize_path(workspace, norm_ws, sizeof(norm_ws));

    /* Path traversal detection: check for .. in path */
    size_t target_len = strlen(norm_target);
    if (strstr(norm_target, "/../") != NULL ||
        (target_len >= 3 && strcmp(norm_target + target_len - 3, "/..") == 0) ||
        strcmp(norm_target, "..") == 0 || strncmp(norm_target, "../", 3) == 0) {
        return false;
    }

    size_t ws_len = strlen(norm_ws);
    if (strncmp(norm_target, norm_ws, ws_len) == 0) {
        if (norm_target[ws_len] == '\0' || norm_target[ws_len] == '/') {
            return true;
        }
    }
    /* If target is relative, e.g. "src/main.c" or "./src" */
    if (norm_target[0] != '/' && !(isalpha((unsigned char)norm_target[0]) && norm_target[1] == ':')) {
        return true;
    }
    return false;
}

SafetyVerdict audit_tool_call(const char *tool_name, const char *path_arg, const char *command_arg, const SafetyContext *ctx) {
    SafetyVerdict v;
    memset(&v, 0, sizeof(v));
    v.tier = SAFETY_TIER_AUTO;
    v.category = CAT_READ;
    v.auto_approvable = true;

    if (!tool_name) return v;

    /* Read-only tools */
    if (strcmp(tool_name, "read_file") == 0 || strcmp(tool_name, "list_directory") == 0 ||
        strcmp(tool_name, "search_files") == 0 || strcmp(tool_name, "glob_files") == 0 ||
        strcmp(tool_name, "get_current_time") == 0) {
        v.tier = SAFETY_TIER_AUTO;
        v.category = CAT_READ;
        v.auto_approvable = true;
        /* But check private data */
        if ((path_arg && touches_private_data(path_arg)) || (command_arg && touches_private_data(command_arg))) {
            v.tier = SAFETY_TIER_HARD;
            v.category = CAT_PRIVATE_DATA;
            v.auto_approvable = false;
            snprintf(v.reason, sizeof(v.reason), "禁止读取敏感凭证与密钥文件。");
        }
        return v;
    }

    /* Command execution tool */
    if (strcmp(tool_name, "run_command") == 0) {
        const char *cmd = (command_arg && *command_arg) ? command_arg : path_arg;
        if (cmd && touches_private_data(cmd)) {
            v.tier = SAFETY_TIER_BLOCKED;
            v.category = CAT_PRIVATE_DATA;
            v.auto_approvable = false;
            snprintf(v.reason, sizeof(v.reason), "命令触碰应用私有数据（密钥库/会话数据库），永久拒绝。");
            return v;
        }
        if (cmd) {
            SafetyVerdict hard_check = audit_hard_lines(cmd);
            if (hard_check.tier != SAFETY_TIER_AUTO) {
                return hard_check;
            }
        }
        /* Autonomy level gating for normal commands */
        if (ctx && ctx->autonomy == AUTONOMY_STRICT) {
            v.tier = SAFETY_TIER_SOFT;
            v.category = CAT_SYSTEM;
            v.auto_approvable = false;
            snprintf(v.reason, sizeof(v.reason), "严格模式下所有命令均需手动确认。");
            return v;
        }

        /* Commands only auto-approve if strictly within whitelist & workspace */
        bool safe = cmd ? is_command_safe_for_auto_approval(cmd, ctx ? ctx->working_directory : ".") : false;
        v.tier = safe ? SAFETY_TIER_AUTO : SAFETY_TIER_SOFT;
        v.category = CAT_SYSTEM;
        v.auto_approvable = safe;
        if (!safe) {
            snprintf(v.reason, sizeof(v.reason), "命令不在安全白名单内或涉及外部/高危调用，需要人工确认。");
        }
        return v;
    }

    /* File write / patch tools */
    if (strcmp(tool_name, "write_file") == 0 || strcmp(tool_name, "patch_file") == 0) {
        if (path_arg && touches_private_data(path_arg)) {
            v.tier = SAFETY_TIER_HARD;
            v.category = CAT_PRIVATE_DATA;
            v.auto_approvable = false;
            snprintf(v.reason, sizeof(v.reason), "严禁直接修改敏感密钥文件。");
            return v;
        }
        if (ctx && ctx->working_directory[0]) {
            if (path_arg && !is_path_inside_workspace(path_arg, ctx->working_directory)) {
                v.tier = SAFETY_TIER_SOFT;
                v.category = CAT_WORKSPACE;
                v.auto_approvable = (ctx->autonomy == AUTONOMY_TRUSTED);
                snprintf(v.reason, sizeof(v.reason), "目标在工作区之外，需要你确认。");
                return v;
            }
        }
        if (ctx && ctx->autonomy == AUTONOMY_STRICT) {
            v.tier = SAFETY_TIER_SOFT;
            v.category = CAT_WORKSPACE;
            v.auto_approvable = false;
            snprintf(v.reason, sizeof(v.reason), "严格模式下写入文件需手动确认。");
            return v;
        }
        /* In balanced or trusted mode, writing inside workspace is auto */
        v.tier = SAFETY_TIER_AUTO;
        v.category = CAT_WORKSPACE;
        v.auto_approvable = true;
        return v;
    }

    return v;
}
