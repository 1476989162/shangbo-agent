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
        strcasestr_local(text, "system prompt") ||
        strcasestr_local(text, "reveal your system") ||
        strcasestr_local(text, "reveal your secret") ||
        strcasestr_local(text, "reveal your api_key") ||
        strcasestr_local(text, "reveal your api-key") ||
        strcasestr_local(text, "reveal your api key") ||
        strcasestr_local(text, "reveal your password") ||
        strcasestr_local(text, "exfiltrat") ||
        strcasestr_local(text, "泄露") ||
        strcasestr_local(text, "窃取") ||
        strcasestr_local(text, "外发") ||
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
