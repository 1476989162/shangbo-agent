#include "../include/native_process.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#include <shellapi.h>

static wchar_t *utf8_wide(const char *input) {
    if (!input) return NULL;
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, -1, NULL, 0);
    if (n <= 0) return NULL;
    wchar_t *out = (wchar_t *)calloc((size_t)n, sizeof(wchar_t));
    if (out) MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, -1, out, n);
    return out;
}

static char *wide_utf8(const wchar_t *input) {
    int n = WideCharToMultiByte(CP_UTF8, 0, input, -1, NULL, 0, NULL, NULL);
    if (n <= 0) return NULL;
    char *out = (char *)calloc((size_t)n, 1);
    if (out) WideCharToMultiByte(CP_UTF8, 0, input, -1, out, n, NULL, NULL);
    return out;
}

static bool append_bytes(char **buffer, size_t *length, size_t *capacity, const char *data, size_t size) {
    if (*length + size + 1 > *capacity) {
        size_t next = *capacity;
        while (*length + size + 1 > next) next *= 2;
        char *grown = (char *)realloc(*buffer, next);
        if (!grown) return false;
        *buffer = grown;
        *capacity = next;
    }
    memcpy(*buffer + *length, data, size);
    *length += size;
    (*buffer)[*length] = '\0';
    return true;
}

static size_t utf8_safe_len_np(const char *s, size_t max_bytes) {
    if (!s || max_bytes == 0) return 0;
    size_t i = 0;
    const unsigned char *u = (const unsigned char *)s;
    while (i < max_bytes && u[i] != '\0') {
        unsigned char c = u[i];
        size_t char_len = 1;
        if (c < 0x80) char_len = 1;
        else if ((c & 0xE0) == 0xC0) char_len = 2;
        else if ((c & 0xF0) == 0xE0) char_len = 3;
        else if ((c & 0xF8) == 0xF0) char_len = 4;
        else return i;
        if (i + char_len > max_bytes) break;
        for (size_t k = 1; k < char_len; ++k) {
            if ((u[i + k] & 0xC0) != 0x80) return i;
        }
        i += char_len;
    }
    return i;
}

static bool append_raw_output(char **buffer, size_t *length, size_t *capacity, const char *data, DWORD bytes, size_t max_output, bool *truncated) {
    size_t keep = *length < max_output ? (bytes < max_output - *length ? bytes : max_output - *length) : 0;
    if (keep < bytes) *truncated = true;
    if (keep == 0) return true;
    return append_bytes(buffer, length, capacity, data, keep);
}

static bool finalize_output_encoding(char **buffer, size_t *length, size_t *capacity, bool truncated) {
    if (!buffer || !*buffer || *length == 0) return true;
    size_t check_len = truncated ? utf8_safe_len_np(*buffer, *length) : *length;
    if (check_len > 0 && MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, *buffer, (int)check_len, NULL, 0) > 0) {
        if (truncated && check_len < *length) {
            *length = check_len;
            (*buffer)[*length] = '\0';
        }
        return true;
    }
    UINT cp = GetConsoleOutputCP();
    if (cp == 0 || cp == CP_UTF8) cp = GetACP();
    if (cp == 0 || cp == CP_UTF8) cp = GetOEMCP();
    if (cp == 0 || cp == CP_UTF8) cp = 936; /* Fallback to CP936 (GBK) on Chinese Windows when console CP is 65001 */

    /* Segment-aware transcoding: bytes < 0x40 (whitespace, newlines, punctuation, digits)
     * are never lead or trail bytes in either UTF-8 or DBCS (GBK/Big5/Shift-JIS).
     * Valid UTF-8 tokens are preserved as-is while legacy codepage tokens are transcoded to UTF-8. */
    size_t out_cap = (*length * 2) + 64;
    size_t out_len = 0;
    char *out_buf = (char *)malloc(out_cap);
    if (!out_buf) return false;
    out_buf[0] = '\0';

    const unsigned char *src = (const unsigned char *)*buffer;
    size_t total = *length;
    size_t pos = 0;
    while (pos < total) {
        if (src[pos] < 0x40) {
            size_t delim_start = pos;
            while (pos < total && src[pos] < 0x40) pos++;
            if (!append_bytes(&out_buf, &out_len, &out_cap, (const char *)(src + delim_start), pos - delim_start)) {
                free(out_buf);
                return false;
            }
            continue;
        }
        size_t tok_start = pos;
        bool has_high = false;
        while (pos < total && src[pos] >= 0x40) {
            if (src[pos] >= 0x80) has_high = true;
            pos++;
        }
        size_t tok_len = pos - tok_start;
        const char *tok_ptr = (const char *)(src + tok_start);
        size_t tok_utf8_check = (pos == total && truncated) ? utf8_safe_len_np(tok_ptr, tok_len) : tok_len;
        if (!has_high || (tok_utf8_check > 0 && MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, tok_ptr, (int)tok_utf8_check, NULL, 0) > 0)) {
            if (!append_bytes(&out_buf, &out_len, &out_cap, tok_ptr, tok_utf8_check)) {
                free(out_buf);
                return false;
            }
        } else {
            int wide_len = MultiByteToWideChar(cp, 0, tok_ptr, (int)tok_len, NULL, 0);
            if (wide_len > 0) {
                wchar_t *wide = (wchar_t *)malloc(sizeof(wchar_t) * (size_t)wide_len);
                if (!wide) { free(out_buf); return false; }
                MultiByteToWideChar(cp, 0, tok_ptr, (int)tok_len, wide, wide_len);
                int ulen = WideCharToMultiByte(CP_UTF8, 0, wide, wide_len, NULL, 0, NULL, NULL);
                if (ulen > 0) {
                    char *utmp = (char *)malloc((size_t)ulen + 1);
                    if (!utmp) { free(wide); free(out_buf); return false; }
                    WideCharToMultiByte(CP_UTF8, 0, wide, wide_len, utmp, ulen, NULL, NULL);
                    bool ok = append_bytes(&out_buf, &out_len, &out_cap, utmp, (size_t)ulen);
                    free(utmp);
                    if (!ok) { free(wide); free(out_buf); return false; }
                }
                free(wide);
            }
        }
    }
    free(*buffer);
    *buffer = out_buf;
    *length = out_len;
    *capacity = out_cap;
    return true;
}

NativeProcessResult native_run_process(const char *command, const char *working_directory, int timeout_ms) {
    return native_run_process_cancellable(command, working_directory, timeout_ms, NULL);
}

NativeProcessResult native_run_process_cancellable(const char *command, const char *working_directory, int timeout_ms, volatile long *cancel_requested) {
    NativeProcessResult result;
    memset(&result, 0, sizeof(result));
    SECURITY_ATTRIBUTES sa;
    HANDLE read_pipe = NULL, write_pipe = NULL, job = NULL, process = NULL, thread = NULL;
    HANDLE wait_timer = NULL;
    PROCESS_INFORMATION pi;
    STARTUPINFOW si;
    memset(&pi, 0, sizeof(pi));
    memset(&si, 0, sizeof(si));
    if (!command || !*command) {
        snprintf(result.error, sizeof(result.error), "Command cannot be empty.");
        return result;
    }
    size_t capacity = 8192;
    result.output = (char *)calloc(capacity, 1);
    if (!result.output) {
        snprintf(result.error, sizeof(result.error), "Out of memory.");
        return result;
    }
    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = TRUE;
    if (!CreatePipe(&read_pipe, &write_pipe, &sa, 0) || !SetHandleInformation(read_pipe, HANDLE_FLAG_INHERIT, 0)) {
        snprintf(result.error, sizeof(result.error), "Failed to create output pipe: %lu", GetLastError());
        goto cleanup;
    }
    wchar_t *cmd = NULL;
    wchar_t *cwd = working_directory && *working_directory ? utf8_wide(working_directory) : NULL;
    wchar_t *user_command = utf8_wide(command);
    if (user_command) {
        /* Ticket 3：只做一次 cmd.exe 定位与拼接。旧版在 quoted(cmd.exe ...)
         * 之上再套一层 "\"%s\" %s"（L185+L193 重复拼接），多余且引入转义歧义。 */
        DWORD length = SearchPathW(NULL, L"cmd.exe", NULL, 0, NULL, NULL);
        if (length > 0) {
            wchar_t *path = (wchar_t *)malloc((size_t)length * sizeof(wchar_t));
            if (path) {
                SearchPathW(NULL, L"cmd.exe", NULL, length, path, NULL);
                size_t total = wcslen(path) + wcslen(user_command) + 32;
                cmd = (wchar_t *)malloc(total * sizeof(wchar_t));
                if (cmd) _snwprintf(cmd, total, L"\"%s\" /d /s /c \"%s\"", path, user_command);
                free(path);
            } else {
                /* SearchPath 缓冲分配失败也要给出 cmd 可用形态，不能静默丢命令 */
                size_t total = wcslen(user_command) + 32;
                cmd = (wchar_t *)malloc(total * sizeof(wchar_t));
                if (cmd) _snwprintf(cmd, total, L"cmd.exe /d /s /c \"%s\"", user_command);
            }
        }
    }
    free(user_command);
    if (!cmd || (working_directory && *working_directory && !cwd)) {
        snprintf(result.error, sizeof(result.error), "Invalid UTF-8 command or working directory.");
        free(cmd);
        free(cwd);
        goto cleanup;
    }
    job = CreateJobObjectW(NULL, NULL);
    if (!job) {
        snprintf(result.error, sizeof(result.error), "Failed to create command isolation job: %lu", GetLastError());
        goto cleanup;
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    memset(&limits, 0, sizeof(limits));
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        snprintf(result.error, sizeof(result.error), "Failed to configure command isolation job: %lu", GetLastError());
        goto cleanup;
    }
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdOutput = write_pipe;
    si.hStdError = write_pipe;
    HANDLE null_input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    /* Ticket 3：CreateFileW 失败返回 INVALID_HANDLE_VALUE 而非 NULL，
     * 旧判定 null_input ? ... : INVALID_HANDLE_VALUE 恒走真分支，失败句柄被当合法 stdin。 */
    si.hStdInput = (null_input != NULL && null_input != INVALID_HANDLE_VALUE) ? null_input : INVALID_HANDLE_VALUE;
    BOOL created = CreateProcessW(NULL, cmd, NULL, NULL, TRUE,
        CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, NULL, cwd, &si, &pi);
    free(cmd);
    free(cwd);
    if (null_input != NULL && null_input != INVALID_HANDLE_VALUE) CloseHandle(null_input);
    if (!created) {
        snprintf(result.error, sizeof(result.error), "Failed to start command: %lu", GetLastError());
        goto cleanup;
    }
    process = pi.hProcess;
    thread = pi.hThread;
    if (job && !AssignProcessToJobObject(job, process)) {
        TerminateProcess(process, 1);
        snprintf(result.error, sizeof(result.error), "Failed to isolate command process: %lu", GetLastError());
        goto cleanup;
    }
    ResumeThread(thread);
    CloseHandle(write_pipe);
    write_pipe = NULL;
    result.started = true;
    DWORD start = GetTickCount();
    if (timeout_ms > 0) {
        wait_timer = CreateWaitableTimerW(NULL, TRUE, NULL);
        if (wait_timer) {
            LARGE_INTEGER due;
            due.QuadPart = -((LONGLONG)timeout_ms * 10000);
            SetWaitableTimer(wait_timer, &due, 0, NULL, NULL, FALSE);
        }
    }
    size_t length = 0;
    bool truncated = false;
    const size_t max_output = 8 * 1024 * 1024;
    while (true) {
        if (cancel_requested && *cancel_requested) {
            result.timed_out = true;
            snprintf(result.error, sizeof(result.error), "Command cancelled by caller; process tree terminated.");
            if (job) TerminateJobObject(job, 1); else TerminateProcess(process, 1);
        }
        /* Ticket 3：排空优先。旧版每轮先固定 WaitForMultipleObjects(20ms) 再 Peek，
         * 高吞吐子进程每 4KB 输出都白等 20ms（吞吐被人为压到 ~200KB/s）。
         * 现在先零超时排空：读到数据立即继续排空（不进等待窗），排空后才等 20ms。 */
        char buffer[4096];
        bool drained_data = false;
        DWORD avail = 0;
        while (PeekNamedPipe(read_pipe, NULL, 0, NULL, &avail, NULL) && avail > 0) {
            DWORD got = 0;
            if (!ReadFile(read_pipe, buffer, (DWORD)(avail < sizeof(buffer) ? avail : sizeof(buffer)), &got, NULL) || got == 0) break;
            drained_data = true;
            if (!append_raw_output(&result.output, &length, &capacity, buffer, got, max_output, &truncated)) {
                snprintf(result.error, sizeof(result.error), "Out of memory decoding command output.");
                if (job) TerminateJobObject(job, 1); else TerminateProcess(process, 1);
                goto cleanup;
            }
        }
        if (drained_data) {
            /* 持续输出的子进程不得永不超时：先零超时检查再继续排空 */
            if (cancel_requested && *cancel_requested) {
                result.timed_out = true;
                snprintf(result.error, sizeof(result.error), "Command cancelled by caller; process tree terminated.");
                if (job) TerminateJobObject(job, 1); else TerminateProcess(process, 1);
            }
            DWORD to_check = (wait_timer == NULL && timeout_ms > 0) ? (DWORD)timeout_ms : 0;
            DWORD elapsed = GetTickCount() - start;
            bool timed_out_now = (wait_timer != NULL) ?
                (WaitForSingleObject(wait_timer, 0) == WAIT_OBJECT_0) :
                (to_check > 0 && elapsed >= to_check);
            if (timed_out_now) {
                result.timed_out = true;
                if (job) TerminateJobObject(job, 1); else TerminateProcess(process, 1);
                WaitForSingleObject(process, 2000);
            }
            if (result.timed_out) break;
            continue;
        } /* 刚读到数据：立刻再排空一轮，不睡 20ms */
        HANDLE waits[2] = { process, wait_timer };
        DWORD wait = wait_timer ? WaitForMultipleObjects(2, waits, FALSE, 20) : WaitForSingleObject(process, 20);
        if (wait == WAIT_FAILED) {
            snprintf(result.error, sizeof(result.error), "Failed waiting for command: %lu", GetLastError());
            TerminateJobObject(job, 1);
            break;
        }
        if ((wait == WAIT_OBJECT_0 + 1 || (wait_timer == NULL && timeout_ms > 0 && GetTickCount() - start >= (DWORD)timeout_ms)) && wait != WAIT_OBJECT_0) {
            result.timed_out = true;
            if (job) TerminateJobObject(job, 1); else TerminateProcess(process, 1);
            WaitForSingleObject(process, 2000);
        }

        if (wait == WAIT_OBJECT_0) {
            if (wait_timer) CancelWaitableTimer(wait_timer);
        }
        if (wait == WAIT_OBJECT_0 || result.timed_out) {
            /* The shell is done, but its children may still hold the pipe.
             * Give them a bounded grace period, then finish without a hanging read. */
            DWORD drain_until = GetTickCount() + 200;
            while (true) {
                DWORD available_now = 0;
                if (!PeekNamedPipe(read_pipe, NULL, 0, NULL, &available_now, NULL)) break;
                if (available_now == 0) {
                    if ((long)(GetTickCount() - drain_until) >= 0) break;
                    Sleep(5);
                    continue;
                }
                DWORD got = 0;
                if (!ReadFile(read_pipe, buffer, (DWORD)(available_now < sizeof(buffer) ? available_now : sizeof(buffer)), &got, NULL) || got == 0) break;
                if (!append_raw_output(&result.output, &length, &capacity, buffer, got, max_output, &truncated)) {
                    snprintf(result.error, sizeof(result.error), "Out of memory decoding command output.");
                    if (job) TerminateJobObject(job, 1); else TerminateProcess(process, 1);
                    goto cleanup;
                }
            }
            break;
        }
    }
    GetExitCodeProcess(process, &result.exit_code);
    if (!finalize_output_encoding(&result.output, &length, &capacity, truncated)) {
        snprintf(result.error, sizeof(result.error), "Out of memory decoding command output.");
        goto cleanup;
    }
    result.output_len = length;
    if (truncated) {
        const char *notice = "\n\n[output truncated at 8 MiB]\n";
        append_bytes(&result.output, &length, &capacity, notice, strlen(notice));
        result.output_len = length;
    }
    if (result.timed_out && !result.error[0]) snprintf(result.error, sizeof(result.error), "Command timed out after %d ms; process tree terminated.", timeout_ms);
cleanup:
    if (wait_timer) CloseHandle(wait_timer);
    if (read_pipe) CloseHandle(read_pipe);
    if (write_pipe) CloseHandle(write_pipe);
    if (thread) CloseHandle(thread);
    if (process) CloseHandle(process);
    if (job) CloseHandle(job);
    return result;
}

void native_process_result_free(NativeProcessResult *result) {
    if (!result) return;
    free(result->output);
    result->output = NULL;
    result->output_len = 0;
}

#else
#include <errno.h>
#include <signal.h>
/* Ticket 3：select() → poll()：FD_SETSIZE 默认 1024，高 fd 进程会越界写 fd_set。 */
#include <poll.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>

static long long monotonic_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

NativeProcessResult native_run_process(const char *command, const char *working_directory, int timeout_ms) {
    return native_run_process_cancellable(command, working_directory, timeout_ms, NULL);
}

NativeProcessResult native_run_process_cancellable(const char *command, const char *working_directory, int timeout_ms, volatile long *cancel_requested) {
    NativeProcessResult result;
    memset(&result, 0, sizeof(result));
    int fds[2];
    if (pipe(fds) != 0) {
        snprintf(result.error, sizeof(result.error), "pipe failed: %s", strerror(errno));
        return result;
    }
    pid_t pid = fork();
    if (pid == 0) {
        setpgid(0, 0);
        if (working_directory && *working_directory && chdir(working_directory) != 0) _exit(126);
        dup2(fds[1], STDOUT_FILENO);
        dup2(fds[1], STDERR_FILENO);
        /* Ticket 3：stdin 重定向 /dev/null。旧版 stdin 继承父进程，
         * 读交互输入的子进程会挂住整条命令管道。 */
        int devnull = open("/dev/null", O_RDONLY);
        if (devnull >= 0) {
            dup2(devnull, STDIN_FILENO);
            if (devnull != STDIN_FILENO) close(devnull);
        } else {
            close(STDIN_FILENO);
        }
        close(fds[0]);
        close(fds[1]);
        execl("/bin/sh", "sh", "-c", command, (char *)NULL);
        _exit(127);
    }
    close(fds[1]);
    if (pid < 0) {
        close(fds[0]);
        snprintf(result.error, sizeof(result.error), "fork failed: %s", strerror(errno));
        return result;
    }
    result.started = true;
    size_t cap = 8192, len = 0;
    result.output = (char *)calloc(cap, 1);
    long long start = monotonic_ms();
    bool done = false;
    bool truncated = false;
    /* Ticket 3：与 Windows 分支对齐的 8MiB 输出截断上限（旧版无上限可被无限输出打爆内存） */
    const size_t max_output = 8 * 1024 * 1024;
    int status = 0;
    while (!done) {
        if (cancel_requested && *cancel_requested) {
            result.timed_out = true;
            snprintf(result.error, sizeof(result.error), "Command cancelled by caller; process tree terminated.");
            kill(-pid, SIGKILL);
            break; /* 立即进入阻塞 waitpid，不再 poll 空转 */
        }
        if (timeout_ms > 0 && monotonic_ms() - start >= timeout_ms) {
            result.timed_out = true;
            kill(-pid, SIGKILL);
            break; /* 立即进入阻塞 waitpid，不再 poll 空转 */
        }
        if (!truncated) {
            struct pollfd pfd;
            pfd.fd = fds[0];
            pfd.events = POLLIN;
            pfd.revents = 0;
            int ready = poll(&pfd, 1, 20);
            if (ready > 0) {
                char chunk[4096];
                ssize_t got = read(fds[0], chunk, sizeof(chunk));
                if (got > 0) {
                    if (len + (size_t)got + 1 > cap) {
                        while (len + (size_t)got + 1 > cap) cap *= 2;
                        char *grown = (char *)realloc(result.output, cap);
                        if (!grown) break;
                        result.output = grown;
                    }
                    memcpy(result.output + len, chunk, (size_t)got);
                    len += (size_t)got;
                    result.output[len] = '\0';
                    if (len >= max_output) {
                        truncated = true;
                        kill(-pid, SIGKILL);
                        result.timed_out = true;
                        snprintf(result.error, sizeof(result.error), "Command output exceeded 8 MiB limit; process tree terminated.");
                        break; /* 直接退出读循环 → 阻塞 waitpid 回收，不再 poll 空转 */
                    }
                } else if (got == 0) break;
            }
        }
        if (waitpid(pid, &status, WNOHANG) == pid) done = true;
    }
    if (!done) waitpid(pid, &status, 0);
    close(fds[0]);
    result.output_len = len;
    if (truncated) {
        const char *notice = "\n\n[output truncated at 8 MiB]\n";
        size_t add = strlen(notice);
        if (len + add + 1 > cap) {
            char *grown = (char *)realloc(result.output, len + add + 1);
            if (grown) { result.output = grown; cap = len + add + 1; }
        }
        if (len + add + 1 <= cap) {
            memcpy(result.output + len, notice, add);
            len += add;
            result.output[len] = '\0';
            result.output_len = len;
        }
    }
    if (WIFEXITED(status)) result.exit_code = (unsigned long)WEXITSTATUS(status);
    else result.exit_code = 1;
    if (result.timed_out && !result.error[0]) snprintf(result.error, sizeof(result.error), "Command timed out after %d ms; process tree terminated.", timeout_ms);
    return result;
}

void native_process_result_free(NativeProcessResult *result) {
    if (!result) return;
    free(result->output);
    result->output = NULL;
    result->output_len = 0;
}
#endif
