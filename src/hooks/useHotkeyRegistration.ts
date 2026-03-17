import { useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { formatHotkeyLabel } from "../utils/hotkeys";
import { validateHotkey } from "../utils/hotkeyValidator";
import { getPlatform } from "../utils/platform";

export interface UseHotkeyRegistrationOptions {
  /**
   * Callback fired when hotkey is successfully registered
   */
  onSuccess?: (hotkey: string) => void;

  /**
   * Callback fired when hotkey registration fails
   */
  onError?: (error: string, hotkey: string) => void;

  /**
   * Show toast notification on success (default: true)
   */
  showSuccessToast?: boolean;

  /**
   * Show toast notification on error (default: true)
   */
  showErrorToast?: boolean;

  /**
   * Custom toast/alert function for showing messages
   */
  showAlert?: (options: { title: string; description: string }) => void;

  registerFn?: (hotkey: string) => Promise<{ success: boolean; message?: string }>;
}

export interface UseHotkeyRegistrationResult {
  /**
   * Register a new hotkey with the system
   */
  registerHotkey: (hotkey: string) => Promise<boolean>;

  /**
   * Whether a registration is currently in progress
   */
  isRegistering: boolean;

  /**
   * The last error message, if any
   */
  lastError: string | null;

  /**
   * Clear the last error
   */
  clearError: () => void;
}

/**
 * Shared hook for hotkey registration with consistent error handling
 * and success/failure notifications.
 *
 * @example
 * const { registerHotkey, isRegistering } = useHotkeyRegistration({
 *   onSuccess: (hotkey) => setDictationKey(hotkey),
 *   showAlert: showAlertDialog,
 * });
 *
 * // Later, when user selects a hotkey:
 * await registerHotkey("CommandOrControl+Shift+K");
 */
export function useHotkeyRegistration(
  options: UseHotkeyRegistrationOptions = {}
): UseHotkeyRegistrationResult {
  const { t } = useTranslation();
  const {
    onSuccess,
    onError,
    showSuccessToast = true,
    showErrorToast = true,
    showAlert,
    registerFn,
  } = options;

  const [isRegistering, setIsRegistering] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  // Use ref to track in-flight requests and prevent double registration
  const registrationInFlightRef = useRef(false);

  const clearError = useCallback(() => {
    setLastError(null);
  }, []);

  const registerHotkey = useCallback(
    async (hotkey: string): Promise<boolean> => {
      // Prevent double registration
      if (registrationInFlightRef.current) {
        return false;
      }

      // Validate hotkey format
      if (!hotkey || hotkey.trim() === "") {
        const errorMsg = t("hooks.hotkeyRegistration.errors.enterValidHotkey");
        setLastError(errorMsg);
        if (showErrorToast && showAlert) {
          showAlert({
            title: t("hooks.hotkeyRegistration.titles.invalidHotkey"),
            description: errorMsg,
          });
        }
        onError?.(errorMsg, hotkey);
        return false;
      }

      const platform = getPlatform();
      const validation = validateHotkey(hotkey, platform);
      if (!validation.valid) {
        const errorMsg =
          validation.error || t("hooks.hotkeyRegistration.errors.unsupportedShortcut");
        setLastError(errorMsg);
        if (showErrorToast && showAlert) {
          showAlert({
            title: t("hooks.hotkeyRegistration.titles.invalidHotkey"),
            description: errorMsg,
          });
        }
        onError?.(errorMsg, hotkey);
        return false;
      }

      // Check if Electron API is available
      const effectiveRegisterFn = registerFn ?? window.electronAPI?.updateHotkey;
      if (!effectiveRegisterFn) {
        // In non-Electron environment, just succeed silently
        onSuccess?.(hotkey);
        return true;
      }

      try {
        registrationInFlightRef.current = true;
        setIsRegistering(true);
        setLastError(null);

        const result = await effectiveRegisterFn(hotkey);

        if (!result?.success) {
          // Use the detailed error message from the manager, which includes suggestions
          const errorMsg = result?.message || t("hooks.hotkeyRegistration.errors.couldNotRegister");
          setLastError(errorMsg);

          if (showErrorToast && showAlert) {
            showAlert({
              title: t("hooks.hotkeyRegistration.titles.notRegistered"),
              description: errorMsg,
            });
          }

          onError?.(errorMsg, hotkey);
          return false;
        }

        // Success!
        if (showSuccessToast && showAlert) {
          const displayLabel = formatHotkeyLabel(hotkey);
          showAlert({
            title: t("hooks.hotkeyRegistration.titles.saved"),
            description: t("hooks.hotkeyRegistration.messages.nowUsing", { hotkey: displayLabel }),
          });
        }

        onSuccess?.(hotkey);
        return true;
      } catch (error) {
        const errorMsg =
          error instanceof Error
            ? error.message
            : t("hooks.hotkeyRegistration.errors.failedToRegister");
        setLastError(errorMsg);

        if (showErrorToast && showAlert) {
          showAlert({
            title: t("hooks.hotkeyRegistration.titles.error"),
            description: errorMsg,
          });
        }

        onError?.(errorMsg, hotkey);
        return false;
      } finally {
        setIsRegistering(false);
        registrationInFlightRef.current = false;
      }
    },
    [onSuccess, onError, showSuccessToast, showErrorToast, showAlert, registerFn, t]
  );

  return {
    registerHotkey,
    isRegistering,
    lastError,
    clearError,
  };
}

export default useHotkeyRegistration;
