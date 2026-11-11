#include "../include/tools.h"
#include "../include/safety.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#include <io.h>
#include <direct.h>
#define POPEN _popen
#define PCLOSE _pclose
#define STRDUP _strdup
#else
#include <unistd.h>
#include <dirent.h>
#include <sys/stat.h>
#define POPEN popen
#define PCLOSE pclose
#define STRDUP strdup
#endif

static FILE *open_file_utf8(const char *path, const char *mode) {
#ifdef _WIN32
    int wpath_len = MultiByteToWideChar(CP_UTF8, 0, path, -1, NULL, 0);
    int wmode_len = MultiByteToWideChar(CP_UTF8, 0, mode, -1, NULL, 0);
    if (wpath_len <= 0 || wmode_len <= 0) return NULL;
    wchar_t *wpath = (wchar_t *)malloc(sizeof(wchar_t) * (wpath_len + 1));
    wchar_t *wmode = (wchar_t *)malloc(sizeof(wchar_t) * (wmode_len + 1));
    if (!wpath || !wmode) {
        free(wpath);
        free(wmode);
        return NULL;
    }
    MultiByteToWideChar(CP_UTF8, 0, path, -1, wpath, wpath_len);
    MultiByteToWideChar(CP_UTF8, 0, mode, -1, wmode, wmode_len);
    FILE *f = _wfopen(wpath, wmode);
    free(wpath);
    free(wmode);
    return f;
#else
    return fopen(path, mode);
#endif
}

/* Creates parent directories if they don't exist */
static void make_parent_dirs(const char *file_path) {
    if (!file_path) return;
    char path_copy[1024];
    strncpy(path_copy, file_path, sizeof(path_copy) - 1);
    path_copy[sizeof(path_copy) - 1] = '\0';

    for (size_t i = 0; path_copy[i]; ++i) {
        if (path_copy[i] == '/' || path_copy[i] == '\\') {
            char sep = path_copy[i];
            path_copy[i] = '\0';
            if (i > 0 && !(i == 2 && path_copy[1] == ':')) {
#ifdef _WIN32
                int wlen = MultiByteToWideChar(CP_UTF8, 0, path_copy, -1, NULL, 0);
                if (wlen > 0) {
                    wchar_t *wbuf = (wchar_t *)malloc(sizeof(wchar_t) * (wlen + 1));
                    if (wbuf) {
                        MultiByteToWideChar(CP_UTF8, 0, path_copy, -1, wbuf, wlen);
                        _wmkdir(wbuf);
                        free(wbuf);
                    }
                }
#else
                mkdir(path_copy, 0755);
#endif
            }
            path_copy[i] = sep;
        }
    }
}

void tool_result_free(ToolResult *res) {
    if (!res) return;
    if (res->output) {
        free(res->output);
        res->output = NULL;
    }
    res->output_len = 0;
    res->success = false;
    res->error_message[0] = '\0';
}

static char *read_entire_file(const char *path, size_t *out_size) {
    FILE *f = open_file_utf8(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    if (sz < 0) {
        fclose(f);
        return NULL;
    }
    fseek(f, 0, SEEK_SET);

    char *buf = (char *)malloc((size_t)sz + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    size_t read_bytes = fread(buf, 1, (size_t)sz, f);
    buf[read_bytes] = '\0';
    fclose(f);

    if (out_size) *out_size = read_bytes;
    return buf;
}

ToolResult tool_read_file(const char *path, int start_line, int end_line, const char *workspace) {
    ToolResult res;
    memset(&res, 0, sizeof(res));

    if (!path || !*path) {
        snprintf(res.error_message, sizeof(res.error_message), "Path cannot be empty.");
        return res;
    }

    if (touches_private_data(path)) {
        snprintf(res.error_message, sizeof(res.error_message), "Access denied: attempting to read sensitive private data.");
        return res;
    }

    size_t file_sz = 0;
    char *content = read_entire_file(path, &file_sz);
    if (!content) {
        snprintf(res.error_message, sizeof(res.error_message), "Failed to open or read file: %s", path);
        return res;
    }

    if (start_line <= 0 && end_line <= 0) {
        /* Return entire content (capped if too large) */
        res.success = true;
        res.output = content;
        res.output_len = file_sz;
        return res;
    }

    /* Extract line range */
    int current_line = 1;
    char *line_start = content;
    char *extracted = (char *)malloc(file_sz + 1);
    if (!extracted) {
        free(content);
        snprintf(res.error_message, sizeof(res.error_message), "Out of memory.");
        return res;
    }
    size_t ext_idx = 0;

    for (size_t i = 0; i <= file_sz; ++i) {
        if (content[i] == '\n' || content[i] == '\0') {
            if ((start_line <= 0 || current_line >= start_line) &&
                (end_line <= 0 || current_line <= end_line)) {
                size_t line_len = (size_t)((content + i) - line_start) + (content[i] == '\n' ? 1 : 0);
                memcpy(extracted + ext_idx, line_start, line_len);
                ext_idx += line_len;
            }
            current_line++;
            line_start = content + i + 1;
        }
        if (content[i] == '\0') break;
    }

    extracted[ext_idx] = '\0';
    free(content);

    res.success = true;
    res.output = extracted;
    res.output_len = ext_idx;
    return res;
}

ToolResult tool_write_file(const char *path, const char *content, bool overwrite, const char *workspace) {
    ToolResult res;
    memset(&res, 0, sizeof(res));

    if (!path || !*path) {
        snprintf(res.error_message, sizeof(res.error_message), "Path cannot be empty.");
        return res;
    }

    if (touches_private_data(path)) {
        snprintf(res.error_message, sizeof(res.error_message), "Security rejection: Writing to private data file is blocked.");
        return res;
    }

    if (workspace && *workspace) {
        if (!is_path_inside_workspace(path, workspace)) {
            snprintf(res.error_message, sizeof(res.error_message), "Security rejection: Writing outside workspace requires explicit approval.");
            return res;
        }
    }

    /* Check if file exists when overwrite is false */
    FILE *check = open_file_utf8(path, "rb");
    if (check) {
        fclose(check);
        if (!overwrite) {
            snprintf(res.error_message, sizeof(res.error_message), "File already exists and overwrite is false.");
            return res;
        }
    }

    /* Ensure parent directories exist before creating file */
    make_parent_dirs(path);

    FILE *f = open_file_utf8(path, "wb");
    if (!f) {
        snprintf(res.error_message, sizeof(res.error_message), "Failed to open file for writing: %s", path);
        return res;
    }

    if (content) {
        size_t c_len = strlen(content);
        fwrite(content, 1, c_len, f);
    }
    fclose(f);

    res.success = true;
    char msg[128];
    snprintf(msg, sizeof(msg), "Successfully wrote file: %s", path);
    res.output = _strdup(msg);
    res.output_len = strlen(msg);
    return res;
}

ToolResult tool_patch_file(const char *path, const char *target, const char *replacement, const char *workspace) {
    ToolResult res;
    memset(&res, 0, sizeof(res));

    if (!path || !target || !replacement) {
        snprintf(res.error_message, sizeof(res.error_message), "Invalid patch arguments.");
        return res;
    }

    if (touches_private_data(path)) {
        snprintf(res.error_message, sizeof(res.error_message), "Security rejection: Patching private credentials is blocked.");
        return res;
    }

    size_t file_sz = 0;
    char *content = read_entire_file(path, &file_sz);
    if (!content) {
        snprintf(res.error_message, sizeof(res.error_message), "Failed to read file for patching: %s", path);
        return res;
    }

    char *pos = strstr(content, target);
    if (!pos) {
        free(content);
        snprintf(res.error_message, sizeof(res.error_message), "Target string not found in file.");
        return res;
    }

    size_t target_len = strlen(target);
    size_t repl_len = strlen(replacement);
    size_t new_size = file_sz - target_len + repl_len;

    char *new_content = (char *)malloc(new_size + 1);
    if (!new_content) {
        free(content);
        snprintf(res.error_message, sizeof(res.error_message), "Out of memory.");
        return res;
    }

    size_t prefix_len = (size_t)(pos - content);
    memcpy(new_content, content, prefix_len);
    memcpy(new_content + prefix_len, replacement, repl_len);
    memcpy(new_content + prefix_len + repl_len, pos + target_len, file_sz - (prefix_len + target_len));
    new_content[new_size] = '\0';
    free(content);

    /* Ensure parent directories exist before creating file */
    make_parent_dirs(path);

    FILE *f = open_file_utf8(path, "wb");
    if (!f) {
        free(new_content);
        snprintf(res.error_message, sizeof(res.error_message), "Failed to open file for saving patch: %s", path);
        return res;
    }
    fwrite(new_content, 1, new_size, f);
    fclose(f);
    free(new_content);

    res.success = true;
    char msg[128];
    snprintf(msg, sizeof(msg), "Successfully patched file: %s", path);
    res.output = _strdup(msg);
    res.output_len = strlen(msg);
    return res;
}

ToolResult tool_list_directory(const char *path, int max_depth, const char *workspace) {
    ToolResult res;
    memset(&res, 0, sizeof(res));

    const char *dir_path = (path && *path) ? path : (workspace && *workspace ? workspace : ".");

    if (touches_private_data(dir_path)) {
        snprintf(res.error_message, sizeof(res.error_message), "Access denied: listing private data directory is blocked.");
        return res;
    }

#ifdef _WIN32
    char search_pattern[1024];
    snprintf(search_pattern, sizeof(search_pattern), "%s\\*", dir_path);

    int wlen = MultiByteToWideChar(CP_UTF8, 0, search_pattern, -1, NULL, 0);
    wchar_t *wsearch = (wchar_t *)malloc(sizeof(wchar_t) * (wlen + 1));
    if (!wsearch) {
        snprintf(res.error_message, sizeof(res.error_message), "Out of memory.");
        return res;
    }
    MultiByteToWideChar(CP_UTF8, 0, search_pattern, -1, wsearch, wlen);

    WIN32_FIND_DATAW fd;
    HANDLE hFind = FindFirstFileW(wsearch, &fd);
    free(wsearch);
    if (hFind == INVALID_HANDLE_VALUE) {
        snprintf(res.error_message, sizeof(res.error_message), "Failed to list directory: %s", dir_path);
        return res;
    }

    size_t buf_cap = 8192;
    char *buf = (char *)malloc(buf_cap);
    if (!buf) {
        FindClose(hFind);
        snprintf(res.error_message, sizeof(res.error_message), "Out of memory.");
        return res;
    }
    buf[0] = '\0';
    size_t buf_len = 0;

    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
        bool is_dir = (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        char utf8_name[512] = {0};
        WideCharToMultiByte(CP_UTF8, 0, fd.cFileName, -1, utf8_name, sizeof(utf8_name), NULL, NULL);

        char line[512];
        int l = snprintf(line, sizeof(line), "%s %s\n", is_dir ? "[DIR] " : "[FILE]", utf8_name);
        if (l > 0) {
            if (buf_len + (size_t)l >= buf_cap) {
                buf_cap *= 2;
                char *new_buf = (char *)realloc(buf, buf_cap);
                if (!new_buf) break;
                buf = new_buf;
            }
            memcpy(buf + buf_len, line, (size_t)l);
            buf_len += (size_t)l;
            buf[buf_len] = '\0';
        }
    } while (FindNextFileW(hFind, &fd));

    FindClose(hFind);

    res.success = true;
    res.output = buf;
    res.output_len = buf_len;
    return res;
#else
    DIR *d = opendir(dir_path);
    if (!d) {
        snprintf(res.error_message, sizeof(res.error_message), "Failed to list directory: %s", dir_path);
        return res;
    }
    size_t buf_cap = 8192;
    char *buf = (char *)malloc(buf_cap);
    if (!buf) {
        closedir(d);
        snprintf(res.error_message, sizeof(res.error_message), "Out of memory.");
        return res;
    }
    buf[0] = '\0';
    size_t buf_len = 0;
    struct dirent *ent;
    while ((ent = readdir(d)) != NULL) {
        if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
        bool is_dir = (ent->d_type == DT_DIR);
        char line[512];
        int l = snprintf(line, sizeof(line), "%s %s\n", is_dir ? "[DIR] " : "[FILE]", ent->d_name);
        if (l > 0) {
            if (buf_len + (size_t)l >= buf_cap) {
                buf_cap *= 2;
                char *new_buf = (char *)realloc(buf, buf_cap);
                if (!new_buf) break;
                buf = new_buf;
            }
            memcpy(buf + buf_len, line, (size_t)l);
            buf_len += (size_t)l;
            buf[buf_len] = '\0';
        }
    }
    closedir(d);
    res.success = true;
    res.output = buf;
    res.output_len = buf_len;
    return res;
#endif
}

ToolResult tool_search_files(const char *path, const char *query, const char *workspace) {
    ToolResult res;
    memset(&res, 0, sizeof(res));

    if (!query || !*query) {
        snprintf(res.error_message, sizeof(res.error_message), "Search query cannot be empty.");
        return res;
    }

    if (touches_private_data(query) || (path && touches_private_data(path))) {
        snprintf(res.error_message, sizeof(res.error_message), "Access denied: searching private sensitive data is blocked.");
        return res;
    }

    const char *dir_path = (path && *path) ? path : (workspace && *workspace ? workspace : ".");
    if (workspace && *workspace && !is_path_inside_workspace(dir_path, workspace)) {
        snprintf(res.error_message, sizeof(res.error_message), "Security rejection: search target must stay inside workspace.");
        return res;
    }

    /* Reject shell injection characters in query */
    for (size_t i = 0; query[i]; ++i) {
        char c = query[i];
        if (c == '&' || c == '|' || c == ';' || c == '`' || c == '$' || c == '<' || c == '>' ||
            c == '^' || c == '%' || c == '"' || c == '\n' || c == '\r') {
            snprintf(res.error_message, sizeof(res.error_message), "Invalid search query: shell metacharacters not allowed.");
            return res;
        }
    }

    char cmd[1024];
#ifdef _WIN32
    char clean_dir[512];
    strncpy(clean_dir, dir_path, sizeof(clean_dir) - 1);
    clean_dir[sizeof(clean_dir) - 1] = '\0';
    for (size_t i = 0; clean_dir[i]; i++) {
        if (clean_dir[i] == '/') clean_dir[i] = '\\';
    }
    size_t cdlen = strlen(clean_dir);
    if (cdlen > 0 && clean_dir[cdlen - 1] == '\\') {
        clean_dir[cdlen - 1] = '\0';
    }
    snprintf(cmd, sizeof(cmd), "findstr /s /i /n \"%s\" \"%s\\*.*\" 2>nul", query, clean_dir);
#else
    snprintf(cmd, sizeof(cmd), "grep -r -n -i -F \"%s\" \"%s\" 2>/dev/null", query, dir_path);
#endif

    FILE *p = POPEN(cmd, "r");
    if (!p) {
        snprintf(res.error_message, sizeof(res.error_message), "Failed to execute search command.");
        return res;
    }

    size_t cap = 8192;
    char *out = (char *)malloc(cap);
    if (!out) {
        PCLOSE(p);
        snprintf(res.error_message, sizeof(res.error_message), "Out of memory.");
        return res;
    }
    out[0] = '\0';
    size_t total = 0;
    char chunk[512];
    while (fgets(chunk, sizeof(chunk), p)) {
        size_t clen = strlen(chunk);
        if (total + clen >= cap) {
            cap *= 2;
            char *n = (char *)realloc(out, cap);
            if (!n) break;
            out = n;
        }
        memcpy(out + total, chunk, clen);
        total += clen;
        out[total] = '\0';
    }
    PCLOSE(p);

    res.success = true;
    res.output = out;
    res.output_len = total;
    return res;
}

ToolResult tool_run_command(const char *command, const char *working_directory, const SafetyContext *safety_ctx) {
    ToolResult res;
    memset(&res, 0, sizeof(res));

    if (!command || !*command) {
        snprintf(res.error_message, sizeof(res.error_message), "Command cannot be empty.");
        return res;
    }

    /* 1. Audit hard redlines and dangerous operations */
    SafetyVerdict v = audit_hard_lines(command);
    if (v.tier == SAFETY_TIER_BLOCKED) {
        snprintf(res.error_message, sizeof(res.error_message), "BLOCKED: %s", v.reason);
        return res;
    }

    if (v.tier == SAFETY_TIER_HARD) {
        snprintf(res.error_message, sizeof(res.error_message), "HARD_APPROVAL_REQUIRED: %s", v.reason);
        return res;
    }

    if (safety_ctx && safety_ctx->autonomy == AUTONOMY_STRICT) {
        snprintf(res.error_message, sizeof(res.error_message), "APPROVAL_REQUIRED: Strict mode requires manual approval for command execution.");
        return res;
    }

    /* 2. Execute command */
    char full_cmd[2048];
    if (working_directory && *working_directory) {
        snprintf(full_cmd, sizeof(full_cmd), "cd /d \"%s\" && %s 2>&1", working_directory, command);
    } else {
        snprintf(full_cmd, sizeof(full_cmd), "%s 2>&1", command);
    }

    FILE *p = POPEN(full_cmd, "r");
    if (!p) {
        snprintf(res.error_message, sizeof(res.error_message), "Failed to spawn command process.");
        return res;
    }

    size_t cap = 8192;
    char *out = (char *)malloc(cap);
    if (!out) {
        PCLOSE(p);
        snprintf(res.error_message, sizeof(res.error_message), "Out of memory.");
        return res;
    }
    size_t total = 0;
    char chunk[512];
    while (fgets(chunk, sizeof(chunk), p)) {
        size_t clen = strlen(chunk);
        if (total + clen >= cap) {
            cap *= 2;
            char *n = (char *)realloc(out, cap);
            if (!n) break;
            out = n;
        }
        memcpy(out + total, chunk, clen);
        total += clen;
        out[total] = '\0';
    }
    int exit_code = PCLOSE(p);

    res.success = (exit_code == 0);
    res.output = out;
    res.output_len = total;
    if (exit_code != 0) {
        snprintf(res.error_message, sizeof(res.error_message), "Command exited with code %d", exit_code);
    }
    return res;
}
