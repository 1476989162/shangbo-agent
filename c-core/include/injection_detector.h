#ifndef SANGBO_AGENT_INJECTION_DETECTOR_H
#define SANGBO_AGENT_INJECTION_DETECTOR_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    INJECTION_NONE = 0,
    INJECTION_LOW = 1,
    INJECTION_HIGH = 2
} InjectionLevel;

typedef struct {
    InjectionLevel level;
    char reason[256];
} InjectionFinding;

/* Fast rule-based scan for prompt injection patterns */
InjectionFinding scan_injection_rules(const char *text);

const char *injection_level_to_string(InjectionLevel level);

#ifdef __cplusplus
}
#endif

#endif /* SANGBO_AGENT_INJECTION_DETECTOR_H */
