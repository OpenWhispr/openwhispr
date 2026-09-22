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
 *   EDITABLE              - Focused element is writable with no live selection (--probe-editable)
 *   NOT_EDITABLE          - Focused element is not safely writable
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

static BSTR read_text_pattern_value(IUIAutomationTextPattern *tp) {
    IUIAutomationTextRange *range = NULL;
    if (FAILED(IUIAutomationTextPattern_get_DocumentRange(tp, &range)) || !range) return NULL;
    BSTR text = NULL;
    HRESULT hr = IUIAutomationTextRange_GetText(range, -1, &text);
    IUIAutomationTextRange_Release(range);
    if (FAILED(hr)) { SysFreeString(text); return NULL; }
    return text;
}

static int text_pattern_is_writable(IUIAutomationTextPattern *tp) {
    IUIAutomationTextRange *range = NULL;
    if (FAILED(IUIAutomationTextPattern_get_DocumentRange(tp, &range)) || !range) return 0;

    VARIANT read_only;
    VariantInit(&read_only);
    HRESULT hr = IUIAutomationTextRange_GetAttributeValue(
        range,
        UIA_IsReadOnlyAttributeId,
        &read_only
    );
    int writable = SUCCEEDED(hr) && read_only.vt == VT_BOOL &&
        read_only.boolVal == VARIANT_FALSE;
    VariantClear(&read_only);
    IUIAutomationTextRange_Release(range);
    return writable;
}

/* A live selection means an EDITABLE verdict would let generated text paste
 * over the user's highlighted text, so the probe must refuse it. This is the
 * authoritative check: the caller's clipboard-based capture cannot see a
 * selection whose text already matches the clipboard. */
static int text_pattern_has_selection(IUIAutomationTextPattern *tp) {
    IUIAutomationTextRangeArray *ranges = NULL;
    if (FAILED(IUIAutomationTextPattern_GetSelection(tp, &ranges)) || !ranges) return 0;

    int has_selection = 0;
    int length = 0;
    IUIAutomationTextRangeArray_get_Length(ranges, &length);
    for (int i = 0; i < length && !has_selection; i++) {
        IUIAutomationTextRange *range = NULL;
        if (FAILED(IUIAutomationTextRangeArray_GetElement(ranges, i, &range)) || !range) continue;
        BSTR text = NULL;
        if (SUCCEEDED(IUIAutomationTextRange_GetText(range, 1, &text)) && text) {
            has_selection = text[0] != L'\0';
            SysFreeString(text);
        }
        IUIAutomationTextRange_Release(range);
    }
    IUIAutomationTextRangeArray_Release(ranges);
    return has_selection;
}

/* An element without a Text pattern cannot report its selection; the verdict
 * stands because the copy-based capture works normally for those controls. */
static int focused_has_selection(IUIAutomationElement *focused) {
    IUIAutomationTextPattern *tp = NULL;
    HRESULT hr = IUIAutomationElement_GetCurrentPatternAs(
        focused, UIA_TextPatternId,
        &IID_IUIAutomationTextPattern, (void **)&tp
    );
    if (FAILED(hr) || !tp) return 0;
    int has_selection = text_pattern_has_selection(tp);
    IUIAutomationTextPattern_Release(tp);
    return has_selection;
}

int main(int argc, char **argv) {
    signal(SIGTERM, signal_handler);
    signal(SIGINT, signal_handler);

    int probe_editable = argc >= 2 && strcmp(argv[1], "--probe-editable") == 0;

    /* Read original text from stdin (consume but don't use) */
    char stdin_buf[4096];
    if (!probe_editable && fgets(stdin_buf, sizeof(stdin_buf), stdin)) {
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

    BOOL isEnabled = FALSE;
    BOOL isKeyboardFocusable = FALSE;
    BOOL isPassword = TRUE;
    if (probe_editable) {
        IUIAutomationElement_get_CurrentIsEnabled(focused, &isEnabled);
        IUIAutomationElement_get_CurrentIsKeyboardFocusable(focused, &isKeyboardFocusable);
        IUIAutomationElement_get_CurrentIsPassword(focused, &isPassword);
    }

    /* Try to get the Value pattern, then fall back to Text pattern */
    IUIAutomationValuePattern *valuePattern = NULL;
    IUIAutomationTextPattern *textPattern = NULL;
    int useTextPattern = 0;
    hr = IUIAutomationElement_GetCurrentPatternAs(
        focused, UIA_ValuePatternId,
        &IID_IUIAutomationValuePattern, (void **)&valuePattern
    );

    if (probe_editable && SUCCEEDED(hr) && valuePattern) {
        BOOL isReadOnly = TRUE;
        HRESULT readOnlyResult = IUIAutomationValuePattern_get_CurrentIsReadOnly(
            valuePattern,
            &isReadOnly
        );
        int editable = isEnabled && isKeyboardFocusable && !isPassword &&
            SUCCEEDED(readOnlyResult) && !isReadOnly &&
            !focused_has_selection(focused);
        printf("%s\n", editable ? "EDITABLE" : "NOT_EDITABLE");
        fflush(stdout);
        IUIAutomationValuePattern_Release(valuePattern);
        IUIAutomationElement_Release(focused);
        IUIAutomation_Release(automation);
        CoUninitialize();
        return 0;
    }

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
        /* No Value pattern — try Text pattern (RichEdit, Monaco, WinUI, Qt, Electron) */
        hr = IUIAutomationElement_GetCurrentPatternAs(
            focused, UIA_TextPatternId,
            &IID_IUIAutomationTextPattern, (void **)&textPattern
        );
        if (SUCCEEDED(hr) && textPattern) {
            if (probe_editable) {
                CONTROLTYPEID controlType = 0;
                IUIAutomationElement_get_CurrentControlType(focused, &controlType);
                int editable = isEnabled && isKeyboardFocusable && !isPassword &&
                    text_pattern_is_writable(textPattern) &&
                    !text_pattern_has_selection(textPattern) &&
                    (controlType == UIA_EditControlTypeId ||
                     controlType == UIA_DocumentControlTypeId);
                printf("%s\n", editable ? "EDITABLE" : "NOT_EDITABLE");
                fflush(stdout);
                IUIAutomationTextPattern_Release(textPattern);
                IUIAutomationElement_Release(focused);
                IUIAutomation_Release(automation);
                CoUninitialize();
                return 0;
            }
            lastValue = read_text_pattern_value(textPattern);
            if (lastValue) {
                useTextPattern = 1;
                print_text_output("INITIAL_VALUE", lastValue);
            }
        }
        if (!useTextPattern) {
            printf("%s\n", probe_editable ? "NOT_EDITABLE" : "NO_VALUE");
            fflush(stdout);
            if (textPattern) IUIAutomationTextPattern_Release(textPattern);
            IUIAutomationElement_Release(focused);
            IUIAutomation_Release(automation);
            CoUninitialize();
            return 0;
        }
    }

    /* Poll for value changes */
    DWORD startTime = GetTickCount();

    while (running) {
        DWORD elapsed = GetTickCount() - startTime;
        if (elapsed >= TIMEOUT_MS) break;

        Sleep(POLL_INTERVAL_MS);

        BSTR currentValue = NULL;
        if (useTextPattern) {
            currentValue = read_text_pattern_value(textPattern);
        } else {
            hr = IUIAutomationValuePattern_get_CurrentValue(valuePattern, &currentValue);
            if (FAILED(hr)) currentValue = NULL;
        }
        if (!currentValue) continue;

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
    if (textPattern) IUIAutomationTextPattern_Release(textPattern);
    if (focused) IUIAutomationElement_Release(focused);
    if (automation) IUIAutomation_Release(automation);
    CoUninitialize();

    return 0;
}
