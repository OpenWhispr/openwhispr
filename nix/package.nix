{
  lib,
  appimageTools,
  fetchurl,
}:

let
  pname = "openwhispr";
  version = "1.7.2";

  src = fetchurl {
    url = "https://github.com/OpenWhispr/openwhispr/releases/download/v${version}/OpenWhispr-${version}-linux-x86_64.AppImage";
    hash = "sha256-EPJTZFtd2bQ026KNcI/FOHfoAMu96HKfJxTPceTc5jw=";
  };

  appimageContents = appimageTools.extractType2 { inherit pname version src; };
in
appimageTools.wrapType2 {
  inherit pname version src;

  # Runtime tools and libraries the AppImage needs but does not bundle.
  # The wrapType2 FHS env already provides the base Chromium/GTK/X11/nss stack;
  # host PATH still resolves compositor tools (hyprctl, qdbus, gsettings, systemctl).
  extraPkgs = pkgs: with pkgs; [
    # Clipboard + keystroke injection backends the app shells out to. See #728.
    xdotool # X11/XWayland keystroke + active-window detection
    wtype # wlroots (Sway/Hyprland) keystroke injection
    ydotool # uinput-based keystroke injection (GNOME/KDE Wayland)
    wl-clipboard # wl-copy / wl-paste
    xclip # X11 clipboard + primary selection
    xsel # X11 clipboard/primary fallback
    kdotool # KDE Wayland active-window class detection for terminal-aware paste
    playerctl # MPRIS media auto-pause fallback
    # Libraries beyond the FHS defaults.
    libsecret # Electron safeStorage keyring (API keys at rest)
    libnotify # Electron desktop notifications
    libpulseaudio # Chromium mic capture via PulseAudio/PipeWire
    stdenv.cc.cc.lib # libstdc++/libgomp for bundled whisper/llama/sherpa/qdrant
  ];

  extraInstallCommands = ''
    install -Dm444 ${appimageContents}/open-whispr.desktop \
      $out/share/applications/${pname}.desktop

    substituteInPlace $out/share/applications/${pname}.desktop \
      --replace-fail 'Exec=AppRun --no-sandbox' 'Exec=${pname} --no-sandbox'

    cp -r ${appimageContents}/usr/share/icons $out/share/icons
  '';

  meta = {
    description = "Privacy-first desktop voice dictation, meeting transcription & notes";
    homepage = "https://openwhispr.com/";
    changelog = "https://github.com/OpenWhispr/openwhispr/releases/tag/v${version}";
    license = lib.licenses.mit;
    sourceProvenance = with lib.sourceTypes; [ binaryNativeCode ];
    platforms = [ "x86_64-linux" ];
    mainProgram = pname;
  };
}
