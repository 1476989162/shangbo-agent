#include "../include/safety.h"
#include "../include/command_guard.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <wctype.h>

#ifdef _WIN32
#include <windows.h>
#define strncasecmp _strnicmp
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

/* Ticket 3：user_data_dir 改线程局部存储（TLS）。
 * 原先是进程级全局 + 无锁写：rpc_task_execute 的工作线程并发跑命令时互相踩踏。
 * TLS 下每个线程（含主线程）持有自己的副本，写入只影响本线程后续检查，
 * 读取方（touches_private_data 等）无锁直读本线程值——「每请求 SafetyContext」语义落地。 */
#ifdef _WIN32
static __declspec(thread) char g_user_data_dir[1024] = {0};
#else
static _Thread_local char g_user_data_dir[1024] = {0};
#endif

void safety_set_user_data_dir(const char *dir) {
    if (!dir) return;
    strncpy(g_user_data_dir, dir, sizeof(g_user_data_dir) - 1);
    g_user_data_dir[sizeof(g_user_data_dir) - 1] = '\0';
}

/* Helper to normalize path slashes to '/' and lowercase */
static void normalize_slashes_lower(const char *in, char *out, size_t out_size) {
    if (!in || out_size == 0) return;
    size_t i = 0;
    for (; in[i] && i + 1 < out_size; ++i) {
        out[i] = (in[i] == '\\') ? '/' : (char)tolower((unsigned char)in[i]);
    }
    out[i] = '\0';
    while (i > 1 && out[i - 1] == '/') {
        out[--i] = '\0';
    }
}

static bool is_env_filename_boundary_left(const char *str, const char *pos) {
    if (pos == str) return true;
    unsigned char prev = (unsigned char)*(pos - 1);
    return isspace(prev) || prev == '/' || prev == '\\' || prev == '"' ||
           prev == '\'' || prev == '=' || prev == ';' || prev == '&' ||
           prev == '|' || prev == '(';
}

static bool is_env_filename_boundary_right(char c) {
    return c == '\0' || isspace((unsigned char)c) || c == '"' || c == '\'' ||
           c == ';' || c == '&' || c == '|' || c == ')';
}

static bool matches_sensitive_dotenv(const char *str) {
    const char *pos = strcasestr_custom(str, ".env");
    while (pos) {
        if (is_env_filename_boundary_left(str, pos)) {
            const char *after = pos + 4;
            if (is_env_filename_boundary_right(*after)) {
                return true;
            }
            if (*after == '.') {
                const char *ext = after + 1;
                size_t len = 0;
                while (ext[len] && !is_env_filename_boundary_right(ext[len]) &&
                       ext[len] != '/' && ext[len] != '\\') {
                    len++;
                }
                if (len > 0 && is_env_filename_boundary_right(ext[len])) {
                    /* Safe template suffixes such as .env.example, .env.sample, .env.template */
                    bool is_safe_template =
                        (len == 7 && strncasecmp(ext, "example", 7) == 0) ||
                        (len == 6 && strncasecmp(ext, "sample", 6) == 0) ||
                        (len == 8 && strncasecmp(ext, "template", 8) == 0) ||
                        (len == 4 && strncasecmp(ext, "dist", 4) == 0) ||
                        (len == 8 && strncasecmp(ext, "defaults", 8) == 0) ||
                        (len == 6 && strncasecmp(ext, "schema", 6) == 0);
                    if (!is_safe_template) {
                        return true;
                    }
                }
            }
        }
        pos = strcasestr_custom(pos + 1, ".env");
    }
    return false;
}

static bool contains_normalized_subpath(const char *norm_haystack, const char *raw_dir) {
    if (!raw_dir || !*raw_dir) return false;
    char norm_dir[1024];
    normalize_slashes_lower(raw_dir, norm_dir, sizeof(norm_dir));
    size_t dlen = strlen(norm_dir);
    if (dlen == 0) return false;
    const char *hit = strstr(norm_haystack, norm_dir);
    while (hit) {
        char after = hit[dlen];
        if (after == '\0' || after == '/' || isspace((unsigned char)after) ||
            after == '"' || after == '\'' || after == ';' || after == '&' || after == '|') {
            return true;
        }
        hit = strstr(hit + 1, norm_dir);
    }
    return false;
}

bool touches_private_data(const char *path_or_command) {
    if (!path_or_command || !*path_or_command) return false;
    if (strcasestr_custom(path_or_command, "secrets.json")) return true;
    if (strcasestr_custom(path_or_command, "shangbo-agent.db")) return true;
    if (strcasestr_custom(path_or_command, ".db-wal") || strcasestr_custom(path_or_command, ".db-shm") ||
        strcasestr_custom(path_or_command, ".db-journal")) return true;
    if (strcasestr_custom(path_or_command, ".ssh\\") || strcasestr_custom(path_or_command, ".ssh/")) return true;
    if (match_word_token(path_or_command, ".ssh")) return true;
    if (strcasestr_custom(path_or_command, ".aws\\") || strcasestr_custom(path_or_command, ".aws/")) return true;
    if (match_word_token(path_or_command, ".aws")) return true;
    if (strcasestr_custom(path_or_command, "id_rsa") || strcasestr_custom(path_or_command, "id_ed25519")) return true;
    if (matches_sensitive_dotenv(path_or_command)) return true;

    char norm[4096];
    normalize_slashes_lower(path_or_command, norm, sizeof(norm));

    /* Check explicit or environment-provided Electron userData directory */
    if (g_user_data_dir[0] && contains_normalized_subpath(norm, g_user_data_dir)) return true;
    const char *env_ud = getenv("SHANGBO_USER_DATA");
    if (env_ud && *env_ud && contains_normalized_subpath(norm, env_ud)) return true;

    const char *appdata = getenv("APPDATA");
    if (appdata && *appdata) {
        char ud_cand[1024];
        snprintf(ud_cand, sizeof(ud_cand), "%s/shangbo-agent", appdata);
        if (contains_normalized_subpath(norm, ud_cand)) return true;
    }
    const char *localappdata = getenv("LOCALAPPDATA");
    if (localappdata && *localappdata) {
        char ud_cand[1024];
        snprintf(ud_cand, sizeof(ud_cand), "%s/shangbo-agent", localappdata);
        if (contains_normalized_subpath(norm, ud_cand)) return true;
    }

    /* Check well-known Electron userData path patterns and env-var expansions */
    if (strstr(norm, "appdata/roaming/shangbo-agent") ||
        strstr(norm, "appdata/local/shangbo-agent") ||
        strstr(norm, "%appdata%/shangbo-agent") ||
        strstr(norm, "%localappdata%/shangbo-agent") ||
        strstr(norm, "$env:appdata/shangbo-agent") ||
        strstr(norm, "$env:localappdata/shangbo-agent") ||
        strstr(norm, ".config/shangbo-agent") ||
        strstr(norm, "application support/shangbo-agent")) {
        return true;
    }

    /* Wildcard + env-var bypasses like `type %APPDATA%\shangbo*\secr*`.
       Literal AppData paths are already covered by the exact userData rules above;
       the loose substring combo only applies to env-var expansions or wildcards,
       otherwise unrelated dirs (e.g. %TEMP%\shangbo-subagent worktrees) false-positive. */
    bool has_appdata_env = strstr(norm, "%appdata%") || strstr(norm, "%localappdata%") ||
                           strstr(norm, "$env:appdata") || strstr(norm, "$env:localappdata");
    bool has_appdata_wildcard = (strstr(norm, "appdata/roaming") || strstr(norm, "appdata/local")) &&
                                strchr(norm, '*') != NULL;
    if ((has_appdata_env || has_appdata_wildcard) &&
        (strstr(norm, "secr") || strstr(norm, "shangbo") || strstr(norm, ".db"))) {
        return true;
    }

    return false;
}

/* Detects whether command is an interpreter or database client that takes inline code inside quotes */
static bool is_quoted_code_host(const char *command) {
    if (!command) return false;
    while (*command && isspace((unsigned char)*command)) command++;
    static const char *hosts[] = {
        "powershell", "pwsh", "cmd", "bash", "sh", "zsh", "ssh", "perl", "ruby", "php",
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
    bool direct_format = false;
    const char *format_pos = cleaned;
    while (*format_pos && isspace((unsigned char)*format_pos)) format_pos++;
    bool quoted_code = is_quoted_code_host(command);
    while (*format_pos && (isspace((unsigned char)*format_pos) || *format_pos == '"' || *format_pos == '\'')) format_pos++;
    if (strncasecmp(format_pos, "format ", 7) == 0 || quoted_code) {
        const char *drive = quoted_code ? strcasestr_custom(cleaned, "format ") : format_pos;
        if (drive) {
            drive += 7;
            while (*drive && isspace((unsigned char)*drive)) drive++;
            direct_format = isalpha((unsigned char)drive[0]) && drive[1] == ':' &&
                            (drive[2] == '\0' || isspace((unsigned char)drive[2]) || drive[2] == '/' || drive[2] == '"');
        }
    }
    if (direct_format || strcasestr_custom(cleaned, "diskpart") ||
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
    if (strcasestr_custom(cleaned, "git filter-branch") || strcasestr_custom(cleaned, "git reflog expire")) {
        v.tier = SAFETY_TIER_HARD;
        v.category = CAT_GIT;
        v.auto_approvable = false;
        snprintf(v.reason, sizeof(v.reason), "检测到重写 Git 历史或清除恢复点：必须人工确认。");
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
        strcasestr_custom(cleaned, "reboot") || strcasestr_custom(cleaned, "taskkill") ||
        strcasestr_custom(cleaned, "net user")) {
        v.tier = SAFETY_TIER_HARD;
        v.category = CAT_SYSTEM;
        v.auto_approvable = false;
        snprintf(v.reason, sizeof(v.reason), "检测到系统关机/重启/删除注册表/强制结束进程等高危系统操作：必须人工确认。");
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

static bool is_path_inside_real_workspace(const char *target_path, const char *workspace) {
    if (!target_path || !workspace || !*target_path || !*workspace) return false;
#ifdef _WIN32
    int target_wlen = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, target_path, -1, NULL, 0);
    int workspace_wlen = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, workspace, -1, NULL, 0);
    if (target_wlen <= 0 || workspace_wlen <= 0) return false;
    wchar_t *target_w = (wchar_t *)malloc((size_t)target_wlen * sizeof(wchar_t));
    wchar_t *workspace_w = (wchar_t *)malloc((size_t)workspace_wlen * sizeof(wchar_t));
    const size_t kPathCap = 32768;
    wchar_t *buf_block = (wchar_t *)calloc(5 * kPathCap, sizeof(wchar_t));
    bool inside = false;
    if (target_w && workspace_w && buf_block) {
        wchar_t *target_real = buf_block;
        wchar_t *workspace_real = buf_block + kPathCap;
        wchar_t *probe = buf_block + 2 * kPathCap;
        wchar_t *ancestor_real = buf_block + 3 * kPathCap;
        wchar_t *suffix = buf_block + 4 * kPathCap;

        MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, target_path, -1, target_w, target_wlen);
        MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, workspace, -1, workspace_w, workspace_wlen);

        DWORD wlen = GetFullPathNameW(workspace_w, (DWORD)kPathCap, workspace_real, NULL);
        if (wlen > 0 && wlen < kPathCap) {
            HANDLE hw = CreateFileW(workspace_real, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
            if (hw != INVALID_HANDLE_VALUE) {
                DWORD actual = GetFinalPathNameByHandleW(hw, workspace_real, (DWORD)kPathCap, FILE_NAME_NORMALIZED);
                CloseHandle(hw);
                if (actual == 0 || actual >= kPathCap) { free(buf_block); free(target_w); free(workspace_w); return false; }
            }
            if (wcsncmp(workspace_real, L"\\\\?\\", 4) == 0) {
                memmove(workspace_real, workspace_real + 4, (wcslen(workspace_real + 4) + 1) * sizeof(wchar_t));
            }
        }

        /* Resolve relative target_path against workspace_real, not process GetCurrentDirectoryW() */
        bool is_rel_target = (target_w[0] != L'/' && target_w[0] != L'\\' &&
                              !(iswalpha(target_w[0]) && target_w[1] == L':'));
        const wchar_t *target_input = target_w;
        if (is_rel_target && wlen > 0 && wlen < kPathCap) {
            int combined = _snwprintf(probe, kPathCap, L"%s\\%s", workspace_real, target_w);
            if (combined > 0 && (size_t)combined < kPathCap) {
                target_input = probe;
            }
        }
        DWORD tlen = GetFullPathNameW(target_input, (DWORD)kPathCap, target_real, NULL);

        /* Resolve the nearest existing ancestor for a not-yet-created file. */
        if (tlen > 0 && tlen < kPathCap) {
            wcscpy(probe, target_real);
            while (GetFileAttributesW(probe) == INVALID_FILE_ATTRIBUTES) {
                wchar_t *slash = wcsrchr(probe, L'\\');
                if (!slash) slash = wcsrchr(probe, L'/');
                if (!slash) break;
                if (slash == probe + 2 && probe[1] == L':') {
                    slash[1] = L'\0';
                    break;
                }
                *slash = L'\0';
            }
            if (GetFileAttributesW(probe) != INVALID_FILE_ATTRIBUTES) {
                HANDLE ancestor = CreateFileW(probe, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
                if (ancestor != INVALID_HANDLE_VALUE) {
                    DWORD actual = GetFinalPathNameByHandleW(ancestor, ancestor_real, (DWORD)kPathCap, FILE_NAME_NORMALIZED);
                    CloseHandle(ancestor);
                    if (actual > 0 && actual < kPathCap) {
                        size_t probe_len = wcslen(probe);
                        if (probe_len == 3 && probe[1] == L':' && (probe[2] == L'\\' || probe[2] == L'/')) {
                            probe_len = 2; /* keep leading slash in suffix when ancestor is drive root C:\ */
                        }
                        wcscpy(suffix, target_real + probe_len);
                        if (wcslen(ancestor_real) + wcslen(suffix) < kPathCap) {
                            wcscpy(target_real, ancestor_real);
                            wcscat(target_real, suffix);
                        }
                    }
                }
            }
        }
        if (tlen > 0 && tlen < kPathCap && wlen > 0 && wlen < kPathCap) {
            HANDLE h = CreateFileW(target_real, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
            if (h != INVALID_HANDLE_VALUE) {
                DWORD actual = GetFinalPathNameByHandleW(h, target_real, (DWORD)kPathCap, FILE_NAME_NORMALIZED);
                CloseHandle(h);
                if (actual == 0 || actual >= kPathCap) { free(buf_block); free(target_w); free(workspace_w); return false; }
            }
            if (wcsncmp(target_real, L"\\\\?\\", 4) == 0) memmove(target_real, target_real + 4, (wcslen(target_real + 4) + 1) * sizeof(wchar_t));
            if (wcsncmp(workspace_real, L"\\\\?\\", 4) == 0) memmove(workspace_real, workspace_real + 4, (wcslen(workspace_real + 4) + 1) * sizeof(wchar_t));
            for (wchar_t *p = target_real; *p; ++p) { if (*p == L'\\') *p = L'/'; *p = (wchar_t)towlower(*p); }
            for (wchar_t *p = workspace_real; *p; ++p) { if (*p == L'\\') *p = L'/'; *p = (wchar_t)towlower(*p); }
            size_t tbase = wcslen(target_real);
            while (tbase > 1 && !(tbase == 3 && target_real[1] == L':') && target_real[tbase - 1] == L'/') {
                target_real[--tbase] = L'\0';
            }
            size_t base = wcslen(workspace_real);
            while (base > 1 && !(base == 3 && workspace_real[1] == L':') && workspace_real[base - 1] == L'/') {
                workspace_real[--base] = L'\0';
            }
            if (base == 3 && workspace_real[1] == L':' && workspace_real[2] == L'/') {
                inside = wcsncmp(target_real, workspace_real, 2) == 0 &&
                         (target_real[2] == L'\0' || target_real[2] == L'/');
            } else {
                inside = wcsncmp(target_real, workspace_real, base) == 0 &&
                         (target_real[base] == L'\0' || target_real[base] == L'/');
            }
        }
    }
    free(buf_block); free(target_w); free(workspace_w);
    return inside;
#else
    char target_real[4096], workspace_real[4096], candidate[4096];
    if (!realpath(workspace, workspace_real)) {
        return is_path_inside_workspace(target_path, workspace);
    }
    if (target_path[0] == '/') {
        if (snprintf(candidate, sizeof(candidate), "%s", target_path) >= (int)sizeof(candidate)) return false;
    } else {
        if (snprintf(candidate, sizeof(candidate), "%s/%s", workspace_real, target_path) >= (int)sizeof(candidate)) return false;
    }
    if (!realpath(candidate, target_real)) {
        if (strstr(candidate, "/../") != NULL || strcmp(candidate, "..") == 0 ||
            strncmp(candidate, "../", 3) == 0 ||
            (strlen(candidate) >= 3 && strcmp(candidate + strlen(candidate) - 3, "/..") == 0)) {
            return false;
        }
        char probe[4096], ancestor_real[4096];
        strcpy(probe, candidate);
        while (!realpath(probe, ancestor_real)) {
            char *slash = strrchr(probe, '/');
            if (!slash) return false;
            if (slash == probe) {
                probe[1] = '\0';
                if (!realpath(probe, ancestor_real)) return false;
                break;
            }
            *slash = '\0';
        }
        size_t probe_len = strlen(probe);
        if (probe_len == 1 && probe[0] == '/') probe_len = 0;
        const char *suffix = candidate + probe_len;
        if (snprintf(target_real, sizeof(target_real), "%s%s", ancestor_real, suffix) >= (int)sizeof(target_real)) return false;
    }
    size_t n = strlen(workspace_real);
    while (n > 1 && workspace_real[n - 1] == '/') workspace_real[--n] = '\0';
    return strncmp(target_real, workspace_real, n) == 0 && (target_real[n] == '\0' || target_real[n] == '/');
#endif
}

/* Ticket 3：检测「递归删除标志 + 目标在工作区外」的组合。
 * 返回 true 表示该命令是对工作区之外整目录的递归/通配清空（hard 红线）。 */
static bool is_cross_workspace_recursive_wipe(const char *cmd, const char *workspace) {
    if (!cmd || !*cmd || !workspace || !*workspace) return false;
    /* 删除动词（大小写不敏感：match_word_token 本身已是 strcasestr） */
    if (!(match_word_token(cmd, "rm") || match_word_token(cmd, "rmdir") ||
          match_word_token(cmd, "rd") || match_word_token(cmd, "del") ||
          match_word_token(cmd, "erase") || match_word_token(cmd, "remove-item"))) return false;
    /* 递归标志或通配符 */
    bool has_wildcard = false;
    for (const char *q = cmd; *q; ++q) {
        if (*q == '*' || *q == '?') { has_wildcard = true; break; }
    }
    /* -Recurse 大小写不敏感（-Recurse/-recurse/-RECURSE 均命中） */
    bool recursive = strstr(cmd, "-r") != NULL || strstr(cmd, "-R") != NULL ||
                      strstr(cmd, "/s") != NULL || strstr(cmd, "/S") != NULL ||
                      strcasestr_custom(cmd, "-recurse") != NULL;
    if (!recursive && !has_wildcard) return false;
    /* 手写 token 扫描（三处绕过修复）：
     * ① 仅跳过 -... 长短标志与 Windows 单字母开关（如 /s /q /f /p），
     *     绝不跳过 /etc/... 等 Unix 绝对路径；
     * ② token 先剥离首尾成对单/双引号再做 .. 与绝对路径校验；
     * ③ 动词比较大小写不敏感（RD /S 也拦）。 */
    const char *verbs[] = {"rm", "rmdir", "rd", "del", "erase", "remove-item", NULL};
    const char *c = cmd;
    while (*c) {
        while (*c == ' ' || *c == '\t' || *c == '\r' || *c == '\n') c++;
        if (!*c) break;
        const char *start = c;
        while (*c && *c != ' ' && *c != '\t' && *c != '\r' && *c != '\n') c++;
        size_t len = (size_t)(c - start);
        char tok[1024];
        if (len == 0 || len >= sizeof(tok)) continue;
        memcpy(tok, start, len); tok[len] = '\0';
        /* 剥离首尾成对引号："../x" → ../x，"C:\\y" → C:\\y */
        size_t tlen = strlen(tok);
        if (tlen >= 2 && ((tok[0] == '"' && tok[tlen - 1] == '"') ||
                           (tok[0] == '\'' && tok[tlen - 1] == '\''))) {
            memmove(tok, tok + 1, tlen - 2);
            tok[tlen - 2] = '\0';
        }
        if (tok[0] == '\0') continue;
        /* 动词大小写不敏感比较（RD /S 也拦，全文字符逐个 tolower 对比） */
        bool is_verb = false;
        for (int i = 0; verbs[i]; ++i) {
            const char *a = tok;
            const char *b = verbs[i];
            while (*a && *b && tolower((unsigned char)*a) == tolower((unsigned char)*b)) { a++; b++; }
            if (*a == '\0' && *b == '\0') { is_verb = true; break; }
        }
        if (is_verb) continue;
        /* 标志判定：-... 全跳过；仅 Windows 单字母开关 /[a-zA-Z] 跳过， */
        /* /etc/... 等多字符路径不跳过（交给后续绝对路径判定） */
        if (start[0] == '-') continue;
        if (start[0] == '/' && len == 2 &&
            isalpha((unsigned char)tok[1])) continue;
        /* 相对路径 .. 逃逸（剥引号后） */
        if (strncmp(tok, "..", 2) == 0) return true;
        /* 绝对路径且不在工作区内 → 跨工作区整目录清除 */
        if ((isalpha((unsigned char)tok[0]) && tok[1] == ':') ||
            tok[0] == '\\' || tok[0] == '/') {
            if (!is_path_inside_real_workspace(tok, workspace)) return true;
        }
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
    if (ctx && ctx->user_data_dir[0]) {
        safety_set_user_data_dir(ctx->user_data_dir);
    }

    /* Read-only tools */
    if (strcmp(tool_name, "read_file") == 0 || strcmp(tool_name, "list_directory") == 0 ||
        strcmp(tool_name, "search_files") == 0 || strcmp(tool_name, "glob_files") == 0 ||
        strcmp(tool_name, "get_current_time") == 0) {
        v.tier = SAFETY_TIER_AUTO;
        v.category = CAT_READ;
        v.auto_approvable = true;
        /* But check private data */
        if ((path_arg && touches_private_data(path_arg)) ||
            (command_arg && touches_private_data(command_arg)) ||
            (ctx && ctx->working_directory[0] && touches_private_data(ctx->working_directory))) {
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
        if ((cmd && touches_private_data(cmd)) ||
            (path_arg && touches_private_data(path_arg)) ||
            (ctx && ctx->working_directory[0] && touches_private_data(ctx->working_directory))) {
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
        /* Ticket 3：跨工作区递归/通配删除 → HARD（对齐 TS safety.ts 的 F:\router 补强）。
         * 工作区绑定 G:\A 时 rd /s /q F:\router 会清空另一个项目；
         * 仅整目录/通配形态升 hard，单文件删除与工作区内清理维持原策略不变。 */
        if (cmd && ctx && ctx->working_directory[0] &&
            is_cross_workspace_recursive_wipe(cmd, ctx->working_directory)) {
            v.tier = SAFETY_TIER_HARD;
            v.category = CAT_WORKSPACE;
            v.auto_approvable = false;
            snprintf(v.reason, sizeof(v.reason), "检测到递归/通配删除工作区之外的目录：可能清空其他项目，必须人工确认。");
            return v;
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
        bool safe = cmd ? is_command_safe_for_auto_approval(cmd, ctx && ctx->working_directory[0] ? ctx->working_directory : ".") : false;
        v.tier = safe ? SAFETY_TIER_AUTO : SAFETY_TIER_SOFT;
        v.category = CAT_SYSTEM;
        v.auto_approvable = safe;
        if (!safe) {
            snprintf(v.reason, sizeof(v.reason), "命令不在安全白名单内或涉及外部/高危调用，需要人工确认。");
        }
        return v;
    }

    /* File write / patch tools（Ticket 3：multi_patch_file 与单 patch 同级，
     * 它是批量写盘入口，漏掉会整批绕过私有数据与工作区边界检查） */
    if (strcmp(tool_name, "write_file") == 0 || strcmp(tool_name, "patch_file") == 0 ||
        strcmp(tool_name, "multi_patch_file") == 0) {
        if ((path_arg && touches_private_data(path_arg)) ||
            (ctx && ctx->working_directory[0] && touches_private_data(ctx->working_directory))) {
            v.tier = SAFETY_TIER_HARD;
            v.category = CAT_PRIVATE_DATA;
            v.auto_approvable = false;
            snprintf(v.reason, sizeof(v.reason), "严禁直接修改敏感密钥文件。");
            return v;
        }
        if (ctx && ctx->working_directory[0]) {
            if (path_arg && *path_arg && !is_path_inside_real_workspace(path_arg, ctx->working_directory)) {
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
