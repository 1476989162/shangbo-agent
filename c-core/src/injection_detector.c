#include "../include/injection_detector.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

static const char *strcasestr_local(const char *haystack, const char *needle) {
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

/** Ticket 2：中文注入词不再裸命中。
 *  「泄露/窃取/外发」后 80 字节内出现敏感目标（密钥/口令/密码/api key/secrets.json）才算 HIGH；
 *  动作词之前的敏感目标不算（防「确保用户密码不明文存储，防止窃取」误报）。
 *  与 TS 侧 injectionDetector.ts 的单向窗口正则保持同一语义。 */
static int cn_injection_pair(const char *text, const char *action) {
    const char *targets[] = {"密钥", "口令", "密码", "api_key", "api-key", "api key", "secrets.json", NULL};
    const char *hit = strcasestr_local(text, action);
    if (!hit) return 0;
    /* 动作词之后 80 字节窗口内找敏感目标（UTF-8 按字节计数，80B ≈ 26 个汉字，窗口足够） */
    for (const char *p = hit; *p && (p - hit) < 80; ++p) {
        for (int i = 0; targets[i]; ++i) {
            size_t len = strlen(targets[i]);
            if (strlen(p) >= len && strncmp(p, targets[i], len) == 0) return 1;
        }
    }
    return 0;
}
const char *injection_level_to_string(InjectionLevel level) {
    switch (level) {
        case INJECTION_NONE: return "none";
        case INJECTION_LOW: return "low";
        case INJECTION_HIGH: return "high";
        default: return "unknown";
    }
}

InjectionFinding scan_injection_rules(const char *text) {
    InjectionFinding finding;
    memset(&finding, 0, sizeof(finding));
    finding.level = INJECTION_NONE;
    snprintf(finding.reason, sizeof(finding.reason), "无注入特征。");

    if (!text || !*text) {
        snprintf(finding.reason, sizeof(finding.reason), "空内容。");
        return finding;
    }

    /* 1. HIGH RISK INJECTION PATTERNS */
    if (strcasestr_local(text, "ignore previous instructions") ||
        strcasestr_local(text, "ignore all previous instructions") ||
        strcasestr_local(text, "ignore prior instructions") ||
        strcasestr_local(text, "ignore all prior instructions") ||
        strcasestr_local(text, "disregard previous instructions") ||
        strcasestr_local(text, "disregard all instructions") ||
        strcasestr_local(text, "disregard prior instructions") ||
        strcasestr_local(text, "disregard all prior instructions") ||
        strcasestr_local(text, "disregard above instructions") ||
        strcasestr_local(text, "忽略之前") ||
        strcasestr_local(text, "忽略以前") ||
        strcasestr_local(text, "忽略上面") ||
        strcasestr_local(text, "忽略上述") ||
        strcasestr_local(text, "忽略所有") ||
        strcasestr_local(text, "忽略全部") ||
        (strcasestr_local(text, "system prompt") && (cn_injection_pair(text, "外发") || strcasestr_local(text, "reveal") || strcasestr_local(text, "忽略"))) ||
        strcasestr_local(text, "reveal your system") ||
        strcasestr_local(text, "reveal your secret") ||
        strcasestr_local(text, "reveal your api_key") ||
        strcasestr_local(text, "reveal your api-key") ||
        strcasestr_local(text, "reveal your api key") ||
        strcasestr_local(text, "reveal your password") ||
        strcasestr_local(text, "exfiltrat") ||
        cn_injection_pair(text, "泄露") ||
        cn_injection_pair(text, "窃取") ||
        cn_injection_pair(text, "外发") ||
        strcasestr_local(text, "send the secrets to") ||
        strcasestr_local(text, "send secrets to") ||
        strcasestr_local(text, "send the credentials to") ||
        strcasestr_local(text, "send credentials to") ||
        strcasestr_local(text, "send the api_key to") ||
        strcasestr_local(text, "send the api-key to") ||
        strcasestr_local(text, "rm -rf /") ||
        strcasestr_local(text, "format c:") ||
        strcasestr_local(text, "drop database") ||
        strcasestr_local(text, "truncate table")) {
        finding.level = INJECTION_HIGH;
        snprintf(finding.reason, sizeof(finding.reason), "命中高危提示词注入特征（越狱/窃密/违背系统提示词/高危破坏指令）。");
        return finding;
    }

    /* 2. LOW RISK SUSPICIOUS PATTERNS */
    if (strcasestr_local(text, "do what i say instead") ||
        strcasestr_local(text, "forget everything above") ||
        strcasestr_local(text, "forget all above") ||
        strcasestr_local(text, "忘记上面") ||
        strcasestr_local(text, "以管理员身份执行") ||
        strcasestr_local(text, "pretend you are") ||
        strcasestr_local(text, "pretend to be") ||
        strcasestr_local(text, "jailbreak") ||
        strcasestr_local(text, "越狱") ||
        strcasestr_local(text, "绕过护栏") ||
        strcasestr_local(text, "绕过审批") ||
        strcasestr_local(text, "[system]") ||
        strcasestr_local(text, "[assistant to=")) {
        finding.level = INJECTION_LOW;
        snprintf(finding.reason, sizeof(finding.reason), "命中可疑指令特征，需提高警惕并保留审批拦截。");
        return finding;
    }

    return finding;
}
