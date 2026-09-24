const { addSwiftPackages } = require('../withSwiftPackages');

const PODFILE = `require File.join(File.dirname(\`node --print "require.resolve('expo/package.json')"\`), "scripts/autolinking")

platform :ios, podfile_properties['ios.deploymentTarget'] || '17.0'

target 'OpenWhispr' do
  use_expo_modules!
end
`;

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('addSwiftPackages', () => {
  it('declares the cocoapods-spm plugin, the Xcode 26 UUID fix and both packages exactly once, before the first target', () => {
    const podfile = addSwiftPackages(PODFILE);

    expect(count(podfile, "plugin 'cocoapods-spm'")).toBe(1);
    expect(count(podfile, 'def generate_available_uuid_list')).toBe(1);
    expect(count(podfile, 'spm_pkg "FluidAudio"')).toBe(1);
    expect(count(podfile, 'spm_pkg "Orukeet"')).toBe(1);
    expect(podfile.indexOf('spm_pkg "Orukeet"')).toBeLessThan(
      podfile.indexOf("target 'OpenWhispr'"),
    );
  });

  it("takes FluidAudio from Oruk's fork at a commit, so a moved tag can't change the build", () => {
    const podfile = addSwiftPackages(PODFILE);

    expect(podfile).toMatch(
      /spm_pkg "FluidAudio", :git => "https:\/\/github\.com\/Oruk-AI\/FluidAudio\.git", :commit => "[0-9a-f]{40}"\n/,
    );
    expect(podfile).not.toContain('FluidInference/FluidAudio');
  });

  it('pins Orukeet to a reviewed commit and links only its OrukeetCoreML product', () => {
    expect(addSwiftPackages(PODFILE)).toMatch(
      /spm_pkg "Orukeet", :git => "https:\/\/github\.com\/Oruk-AI\/orukeet\.git", :commit => "[0-9a-f]{40}", :products => \["OrukeetCoreML"\]/,
    );
  });

  it('creates the copy-resources file lists cocoapods-spm appends SPM resources to, once', () => {
    const podfile = addSwiftPackages(PODFILE);

    expect(count(podfile, 'pre_integrate do |installer|')).toBe(1);
    expect(podfile).toContain('copy_resources_script_input_files_path(config)');
    expect(podfile).toContain('copy_resources_script_output_files_path(config)');
  });

  it('leaves a Podfile it already patched untouched', () => {
    const once = addSwiftPackages(PODFILE);
    expect(addSwiftPackages(once)).toBe(once);
  });

  it('refuses to patch over packages a stale prebuild declared, asking for a clean prebuild', () => {
    const stale = PODFILE.replace(
      'target ',
      `plugin 'cocoapods-spm'\nspm_pkg "FluidAudio", :git => "https://github.com/FluidInference/FluidAudio.git", :version => "0.15.4"\n\ntarget `,
    );

    expect(() => addSwiftPackages(stale)).toThrow(/expo prebuild -p ios --clean/);
  });

  it('appends at the top level when the Podfile has no target block', () => {
    const podfile = addSwiftPackages("platform :ios, '17.0'\n");

    expect(podfile.startsWith("platform :ios, '17.0'\n")).toBe(true);
    expect(count(podfile, 'spm_pkg "Orukeet"')).toBe(1);
  });
});
