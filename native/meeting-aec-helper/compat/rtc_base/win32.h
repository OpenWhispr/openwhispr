// Shim: webrtc-apm omits rtc_base/win32.h but time_utils.cc includes it under
// WEBRTC_WIN and then includes <minwinbase.h>, which requires the base Win32
// types (HANDLE, DWORD, LPVOID, ...) to already be declared.
#ifndef OPENWHISPR_COMPAT_RTC_BASE_WIN32_H_
#define OPENWHISPR_COMPAT_RTC_BASE_WIN32_H_

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <windows.h>

#endif
