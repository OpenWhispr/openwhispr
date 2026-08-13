{
  description = "OpenWhispr – privacy-first voice dictation, meeting transcription & notes";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          openwhispr = pkgs.callPackage ./nix/package.nix { };
        in
        {
          default = openwhispr;
          openwhispr = openwhispr;
        }
      );

      overlays.default = _final: _prev: {
        openwhispr = self.packages.x86_64-linux.openwhispr;
      };

      nixosModules.default = import ./nix/module.nix self;
    };
}
