import fs from 'fs';
import os from 'os';
import path from 'path';

const xcode = require('xcode');
const withKeyboardExtension = require('../withKeyboardExtension');
const { EXTENSION_FILES, ensureExtensionFiles, ensureExtensionGroup, writeExtensionSupportFiles } =
  withKeyboardExtension;

const APP_TARGET = 'B40000000000000000000001';
const KEYBOARD_TARGET = 'B40000000000000000000002';

// A minimal project as `expo prebuild` leaves it after the keyboard target exists: the
// app target, the keyboard target with KeyboardViewController.swift in its Sources, and
// an app-side group the collision test can put a same-named file into.
const FIXTURE = `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 54;
	objects = {

/* Begin PBXBuildFile section */
		B10000000000000000000001 /* KeyboardViewController.swift in Sources */ = {isa = PBXBuildFile; fileRef = B20000000000000000000001 /* KeyboardViewController.swift */; };
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
		B20000000000000000000001 /* KeyboardViewController.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = KeyboardViewController.swift; sourceTree = "<group>"; };
/* End PBXFileReference section */

/* Begin PBXGroup section */
		B30000000000000000000001 = {
			isa = PBXGroup;
			children = (
				B30000000000000000000002 /* OpenWhisprKeyboard */,
				B30000000000000000000003 /* App */,
			);
			sourceTree = "<group>";
		};
		B30000000000000000000002 /* OpenWhisprKeyboard */ = {
			isa = PBXGroup;
			children = (
				B20000000000000000000001 /* KeyboardViewController.swift */,
			);
			name = OpenWhisprKeyboard;
			path = OpenWhisprKeyboard;
			sourceTree = "<group>";
		};
		B30000000000000000000003 /* App */ = {
			isa = PBXGroup;
			children = (
			);
			name = App;
			path = App;
			sourceTree = "<group>";
		};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
		B40000000000000000000001 /* App */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = B70000000000000000000001 /* Build configuration list */;
			buildPhases = (
				B50000000000000000000001 /* Sources */,
				B50000000000000000000003 /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			name = App;
			productName = App;
			productType = "com.apple.product-type.application";
		};
		B40000000000000000000002 /* OpenWhisprKeyboard */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = B70000000000000000000001 /* Build configuration list */;
			buildPhases = (
				B50000000000000000000002 /* Sources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			name = OpenWhisprKeyboard;
			productName = OpenWhisprKeyboard;
			productType = "com.apple.product-type.app-extension";
		};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
		B60000000000000000000001 /* Project object */ = {
			isa = PBXProject;
			buildConfigurationList = B70000000000000000000001 /* Build configuration list */;
			compatibilityVersion = "Xcode 14.0";
			mainGroup = B30000000000000000000001;
			projectDirPath = "";
			projectRoot = "";
			targets = (
				B40000000000000000000001 /* App */,
				B40000000000000000000002 /* OpenWhisprKeyboard */,
			);
		};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
		B50000000000000000000003 /* Resources */ = {
			isa = PBXResourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
		B50000000000000000000001 /* Sources */ = {
			isa = PBXSourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
		B50000000000000000000002 /* Sources */ = {
			isa = PBXSourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
				B10000000000000000000001 /* KeyboardViewController.swift in Sources */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXSourcesBuildPhase section */

/* Begin XCBuildConfiguration section */
		B80000000000000000000001 /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
			};
			name = Debug;
		};
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
		B70000000000000000000001 /* Build configuration list */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				B80000000000000000000001 /* Debug */,
			);
			defaultConfigurationName = Debug;
		};
/* End XCConfigurationList section */
	};
	rootObject = B60000000000000000000001 /* Project object */;
}
`;

function parseProject(contents: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-plugin-'));
  const file = path.join(dir, 'project.pbxproj');
  fs.writeFileSync(file, contents);
  const project = xcode.project(file);
  project.parseSync();
  return project;
}

type Project = ReturnType<typeof parseProject>;

function phaseFiles(project: Project, targetUuid: string, isa: string): string[] {
  const phases = project.hash.project.objects[isa] || {};
  const target = project.pbxNativeTargetSection()[targetUuid];
  const buildFiles = project.hash.project.objects.PBXBuildFile;
  const fileRefs = project.pbxFileReferenceSection();
  return target.buildPhases
    .filter((ref: { value: string }) => phases[ref.value])
    .flatMap((ref: { value: string }) => phases[ref.value].files)
    .map((entry: { value: string }) =>
      String(fileRefs[buildFiles[entry.value].fileRef].path).replace(/"/g, ''),
    )
    .sort();
}

// The same project before the keyboard target exists, as a clean `expo prebuild` (EAS) has it.
function appOnlyProject() {
  const project = parseProject(FIXTURE);
  const objects = project.hash.project.objects;
  const keyboardOnly: [string, string][] = [
    ['PBXNativeTarget', KEYBOARD_TARGET],
    ['PBXSourcesBuildPhase', 'B50000000000000000000002'],
    ['PBXGroup', 'B30000000000000000000002'],
    ['PBXFileReference', 'B20000000000000000000001'],
    ['PBXBuildFile', 'B10000000000000000000001'],
  ];
  for (const [section, key] of keyboardOnly) {
    delete objects[section][key];
    delete objects[section][`${key}_comment`];
  }
  const root = objects.PBXProject.B60000000000000000000001;
  root.targets = root.targets.filter((ref: { value: string }) => ref.value !== KEYBOARD_TARGET);
  const mainGroup = objects.PBXGroup.B30000000000000000000001;
  mainGroup.children = mainGroup.children.filter(
    (ref: { value: string }) => ref.value !== 'B30000000000000000000002',
  );
  return project;
}

const PLUGIN_CONFIG = {
  name: 'OpenWhispr',
  slug: 'openwhispr',
  extra: {
    openWhispr: {
      iosBundleIdentifier: 'com.example.app',
      scheme: 'openwhispr',
      appGroupId: 'group.com.example.app',
    },
  },
};

function modRequest(platformProjectRoot: string) {
  return {
    projectRoot: platformProjectRoot,
    platformProjectRoot,
    projectName: 'App',
    platform: 'ios',
    introspect: false,
  };
}

function keyboardTargetUuid(project: Project) {
  const targets = project.pbxNativeTargetSection();
  return Object.keys(targets).find(
    (key) => String(targets[key].name).replace(/"/g, '') === 'OpenWhisprKeyboard',
  );
}

function phaseCount(project: Project, targetUuid: string, isa: string) {
  const phases = project.hash.project.objects[isa] || {};
  return project
    .pbxNativeTargetSection()
    [targetUuid].buildPhases.filter((ref: { value: string }) => phases[ref.value]).length;
}

function expectKeyboardWiring(project: Project, keyboardTarget = KEYBOARD_TARGET) {
  expect(phaseFiles(project, keyboardTarget, 'PBXSourcesBuildPhase')).toEqual([
    'KeyboardCapitalization.swift',
    'KeyboardViewController.swift',
  ]);
  expect(phaseFiles(project, keyboardTarget, 'PBXResourcesBuildPhase')).toEqual([]);
  expect(phaseFiles(project, APP_TARGET, 'PBXSourcesBuildPhase')).toEqual([]);
  expect(phaseFiles(project, APP_TARGET, 'PBXResourcesBuildPhase')).toEqual([]);
}

describe('withKeyboardExtension helpers', () => {
  it('wires both sources into the keyboard target only', () => {
    const project = parseProject(FIXTURE);
    ensureExtensionFiles(project, KEYBOARD_TARGET, ensureExtensionGroup(project));

    expectKeyboardWiring(project);
  });

  it('is idempotent and survives a write/parse round trip', () => {
    const project = parseProject(FIXTURE);
    ensureExtensionFiles(project, KEYBOARD_TARGET, ensureExtensionGroup(project));
    ensureExtensionFiles(project, KEYBOARD_TARGET, ensureExtensionGroup(project));
    const written = project.writeSync();

    for (const file of EXTENSION_FILES) {
      expect(written.split(`${file.name} in ${file.phase} */,`).length - 1).toBe(1);
    }
    expectKeyboardWiring(parseProject(written));
  });

  it('moves a source that prebuild left in the app target', () => {
    const project = parseProject(FIXTURE);
    const appSources = project.hash.project.objects.PBXSourcesBuildPhase.B50000000000000000000001;
    appSources.files.push({
      value: 'B10000000000000000000001',
      comment: 'KeyboardViewController.swift in Sources',
    });

    ensureExtensionFiles(project, KEYBOARD_TARGET, ensureExtensionGroup(project));

    expectKeyboardWiring(project);
  });

  it('refuses to take over an app file with the same name', () => {
    const project = parseProject(
      FIXTURE.replace(
        '/* End PBXFileReference section */',
        '\t\tB20000000000000000000009 /* KeyboardCapitalization.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = KeyboardCapitalization.swift; sourceTree = "<group>"; };\n/* End PBXFileReference section */',
      )
        .replace(
          '/* End PBXBuildFile section */',
          '\t\tB10000000000000000000009 /* KeyboardCapitalization.swift in Sources */ = {isa = PBXBuildFile; fileRef = B20000000000000000000009 /* KeyboardCapitalization.swift */; };\n/* End PBXBuildFile section */',
        )
        .replace(
          'B30000000000000000000003 /* App */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n',
          'B30000000000000000000003 /* App */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\tB20000000000000000000009 /* KeyboardCapitalization.swift */,\n',
        )
        .replace(
          'B50000000000000000000001 /* Sources */ = {\n\t\t\tisa = PBXSourcesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n',
          'B50000000000000000000001 /* Sources */ = {\n\t\t\tisa = PBXSourcesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n\t\t\t\tB10000000000000000000009 /* KeyboardCapitalization.swift in Sources */,\n',
        ),
    );

    expect(() =>
      ensureExtensionFiles(project, KEYBOARD_TARGET, ensureExtensionGroup(project)),
    ).toThrow(/KeyboardCapitalization\.swift/);
    expect(phaseFiles(project, APP_TARGET, 'PBXSourcesBuildPhase')).toEqual([
      'KeyboardCapitalization.swift',
    ]);
  });

  it('copies every extension file into the generated project', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-plugin-ios-'));
    writeExtensionSupportFiles(root, {
      keyboardDisplayName: 'OpenWhispr',
      scheme: 'openwhispr',
      iosBundleIdentifier: 'com.example.app',
      appGroupId: 'group.com.example.app',
    });

    for (const file of EXTENSION_FILES) {
      expect(fs.existsSync(path.join(root, 'OpenWhisprKeyboard', file.name))).toBe(true);
    }
  });
});

describe('withKeyboardExtension mods', () => {
  function writeProject(root: string, contents: string) {
    const file = path.join(root, 'App.xcodeproj', 'project.pbxproj');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  }

  it('adds and wires the keyboard target on a clean prebuild', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-plugin-clean-'));
    const config = withKeyboardExtension(structuredClone(PLUGIN_CONFIG));

    const result = await config.mods.ios.xcodeproj({
      ...config,
      modResults: appOnlyProject(),
      modRequest: modRequest(root),
    });

    const keyboardTarget = keyboardTargetUuid(result.modResults);
    expect(keyboardTarget).toBeDefined();
    expectKeyboardWiring(result.modResults, keyboardTarget);
    expect(phaseCount(result.modResults, keyboardTarget!, 'PBXSourcesBuildPhase')).toBe(1);
    expect(phaseCount(result.modResults, keyboardTarget!, 'PBXResourcesBuildPhase')).toBe(0);
  });

  it('repairs the wiring of a project an earlier prebuild left behind', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-plugin-again-'));
    const file = writeProject(root, FIXTURE);
    const config = withKeyboardExtension(structuredClone(PLUGIN_CONFIG));

    await config.mods.ios.dangerous({ ...config, modRequest: modRequest(root) });

    const project = parseProject(fs.readFileSync(file, 'utf8'));
    expectKeyboardWiring(project);
    expect(phaseCount(project, KEYBOARD_TARGET, 'PBXSourcesBuildPhase')).toBe(1);
    expect(phaseCount(project, KEYBOARD_TARGET, 'PBXResourcesBuildPhase')).toBe(0);
  });

  it('leaves a project without the keyboard target to the xcodeproj mod', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-plugin-app-only-'));
    const appOnly = appOnlyProject().writeSync();
    const file = writeProject(root, appOnly);
    const config = withKeyboardExtension(structuredClone(PLUGIN_CONFIG));

    await config.mods.ios.dangerous({ ...config, modRequest: modRequest(root) });

    expect(fs.readFileSync(file, 'utf8')).toBe(appOnly);
  });
});
