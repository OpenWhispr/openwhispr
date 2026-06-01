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
