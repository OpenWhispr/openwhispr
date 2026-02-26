/**
 * Windows Text Edit Monitor
 *
 * Uses UI Automation to monitor the focused text field for value changes.
 * Outputs "CHANGED:<value>" to stdout when the text changes.
 * Exits after a timeout or on receiving a termination signal.
 *
 * Protocol (stdout):
 *   INITIAL_VALUE:<text>  - Initial text field value
 *   INITIAL_VALUE_B64:<base64> - Initial text field value (multiline)
 *   CHANGED:<text>        - Text field value after a change
 *   CHANGED_B64:<base64>  - Text field value after a change (multiline)
 *   NO_ELEMENT            - Could not get focused element
 *   NO_VALUE              - Focused element has no text value
 *
 * Input (stdin):
 *   First line: original pasted text (informational)
 *
 * Compile:
 *   cl /O2 windows-text-monitor.c /Fe:windows-text-monitor.exe ole32.lib oleaut32.lib
 *   or: gcc -O2 windows-text-monitor.c -o windows-text-monitor.exe -lole32 -loleaut32 -luuid
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>

#define COBJMACROS
#include <windows.h>
#include <oleauto.h>
#include <uiautomation.h>

#define TIMEOUT_MS 30000
#define POLL_INTERVAL_MS 500
#define MAX_OUTPUT_CHARS 10240

static volatile int running = 1;
static const char BASE64_TABLE[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

void signal_handler(int sig) {
    (void)sig;
    running = 0;
}

char *base64_encode(const unsigned char *data, size_t len) {
    size_t out_len = 4 * ((len + 2) / 3);
    char *out = (char *)malloc(out_len + 1);
    if (!out) return NULL;

    size_t i = 0, j = 0;
    while (i < len) {
        unsigned int octet_a = i < len ? data[i++] : 0;
        unsigned int octet_b = i < len ? data[i++] : 0;
        unsigned int octet_c = i < len ? data[i++] : 0;
        unsigned int triple = (octet_a << 16) | (octet_b << 8) | octet_c;

        out[j++] = BASE64_TABLE[(triple >> 18) & 0x3F];
        out[j++] = BASE64_TABLE[(triple >> 12) & 0x3F];
        out[j++] = BASE64_TABLE[(triple >> 6) & 0x3F];
        out[j++] = BASE64_TABLE[triple & 0x3F];
    }

    if (len % 3 == 1) {
        out[out_len - 1] = '=';
        out[out_len - 2] = '=';
    } else if (len % 3 == 2) {
        out[out_len - 1] = '=';
    }

    out[out_len] = '\0';
    return out;
}

void print_text_output(const char *name, const WCHAR *value) {
    if (!value) return;

    /* Convert wide string to UTF-8 (needed includes the null terminator) */
    int needed = WideCharToMultiByte(CP_UTF8, 0, value, -1, NULL, 0, NULL, NULL);
    if (needed <= 0) return;

    char *utf8 = (char *)malloc((size_t)needed);
    if (!utf8) return;

    int written = WideCharToMultiByte(CP_UTF8, 0, value, -1, utf8, needed, NULL, NULL);
    if (written <= 0) {
        free(utf8);
        return;
    }
    utf8[needed - 1] = '\0';

    size_t utf8_len = strlen(utf8);
    size_t limit = utf8_len < MAX_OUTPUT_CHARS ? utf8_len : MAX_OUTPUT_CHARS;

    if (memchr(utf8, '\n', limit) || memchr(utf8, '\r', limit)) {
        char *encoded = base64_encode((const unsigned char *)utf8, limit);
        if (encoded) {
            printf("%s_B64:%s\n", name, encoded);
            fflush(stdout);
            free(encoded);
        }
    } else {
        printf("%s:%.*s\n", name, (int)limit, utf8);
        fflush(stdout);
    }

    free(utf8);
}

int main(void) {
    signal(SIGTERM, signal_handler);
    signal(SIGINT, signal_handler);

    /* Read original text from stdin (consume but don't use) */
    char stdin_buf[4096];
    if (fgets(stdin_buf, sizeof(stdin_buf), stdin)) {
        /* consumed */
    }

    /* Initialize COM */
    HRESULT hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    if (FAILED(hr)) {
        fprintf(stderr, "CoInitializeEx failed: 0x%lx\n", hr);
        printf("NO_ELEMENT\n");
        fflush(stdout);
        return 1;
    }

    /* Create UI Automation instance */
    IUIAutomation *automation = NULL;
    hr = CoCreateInstance(
        &CLSID_CUIAutomation, NULL, CLSCTX_INPROC_SERVER,
        &IID_IUIAutomation, (void **)&automation
    );
    if (FAILED(hr) || !automation) {
        fprintf(stderr, "Failed to create IUIAutomation: 0x%lx\n", hr);
        printf("NO_ELEMENT\n");
        fflush(stdout);
        CoUninitialize();
        return 1;
    }

    /* Get the focused element */
    IUIAutomationElement *focused = NULL;
    hr = IUIAutomation_GetFocusedElement(automation, &focused);
    if (FAILED(hr) || !focused) {
        fprintf(stderr, "Failed to get focused element: 0x%lx\n", hr);
        printf("NO_ELEMENT\n");
        fflush(stdout);
        IUIAutomation_Release(automation);
        CoUninitialize();
        return 1;
    }

    /* Try to get the Value pattern */
    IUIAutomationValuePattern *valuePattern = NULL;
    hr = IUIAutomationElement_GetCurrentPatternAs(
        focused, UIA_ValuePatternId,
        &IID_IUIAutomationValuePattern, (void **)&valuePattern
    );

    BSTR lastValue = NULL;

    if (SUCCEEDED(hr) && valuePattern) {
        /* Read initial value via Value pattern */
        hr = IUIAutomationValuePattern_get_CurrentValue(valuePattern, &lastValue);
        if (SUCCEEDED(hr) && lastValue) {
            print_text_output("INITIAL_VALUE", lastValue);
        } else {
            printf("NO_VALUE\n");
            fflush(stdout);
            IUIAutomationValuePattern_Release(valuePattern);
            IUIAutomationElement_Release(focused);
            IUIAutomation_Release(automation);
            CoUninitialize();
            return 0;
        }
    } else {
        /* No Value pattern — try getting the Name property as fallback */
        BSTR name = NULL;
        hr = IUIAutomationElement_get_CurrentName(focused, &name);
        if (SUCCEEDED(hr) && name && SysStringLen(name) > 0) {
            /* Element has a name but no editable value — not a text field */
            SysFreeString(name);
        }
        printf("NO_VALUE\n");
        fflush(stdout);
        IUIAutomationElement_Release(focused);
        IUIAutomation_Release(automation);
        CoUninitialize();
        return 0;
    }

    /* Poll for value changes */
    DWORD startTime = GetTickCount();

    while (running) {
        DWORD elapsed = GetTickCount() - startTime;
        if (elapsed >= TIMEOUT_MS) break;

        Sleep(POLL_INTERVAL_MS);

        BSTR currentValue = NULL;
        hr = IUIAutomationValuePattern_get_CurrentValue(valuePattern, &currentValue);
        if (FAILED(hr) || !currentValue) continue;

        /* Compare with last known value */
        if (lastValue && wcscmp(currentValue, lastValue) != 0) {
            print_text_output("CHANGED", currentValue);
            SysFreeString(lastValue);
            lastValue = currentValue;
        } else {
            SysFreeString(currentValue);
        }
    }

    /* Cleanup */
    if (lastValue) SysFreeString(lastValue);
    if (valuePattern) IUIAutomationValuePattern_Release(valuePattern);
    if (focused) IUIAutomationElement_Release(focused);
    if (automation) IUIAutomation_Release(automation);
    CoUninitialize();

    return 0;
}
