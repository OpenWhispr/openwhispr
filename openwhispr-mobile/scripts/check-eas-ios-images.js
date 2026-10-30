#!/usr/bin/env node
// Fails when an EAS build profile could build iOS on an unreviewed image. EAS moves "latest" (and
// the default used when no image is set) to new Xcode releases without notice, and 1.2.4 (40)
// shipped built with the iOS 27 SDK, which iOS 27 refuses to launch without the UIScene lifecycle.
const { readFileSync } = require('node:fs');
const path = require('node:path');

// Moving to a new Xcode is a reviewed edit here. An Xcode 27+ image needs the UIScene lifecycle
// (plugins/scene-lifecycle) and a passing `npm run verify:ios-launch` before it is added.
const ALLOWED_IOS_IMAGES = ['macos-tahoe-26.5-xcode-26.6'];

/**
 * Resolves a profile's iOS image through its `extends` chain, as EAS merges profiles.
 * @param {Record<string, any>} profiles
 * @param {string} name
 * @param {string[]} [seen]
 * @returns {unknown}
 */
function resolveIosImage(profiles, name, seen = []) {
  if (seen.includes(name)) {
    throw new Error(`build profile "${name}" extends itself (${[...seen, name].join(' -> ')})`);
  }
  const profile = profiles[name];
  if (!profile || typeof profile !== 'object') {
    throw new Error(`build profile "${seen.at(-1)}" extends missing profile "${name}"`);
  }
  if (profile.ios && Object.hasOwn(profile.ios, 'image')) return profile.ios.image;
  if (typeof profile.extends === 'string') {
    return resolveIosImage(profiles, profile.extends, [...seen, name]);
  }
  return undefined;
}

/**
 * Every build profile can be run with `--platform ios`, so every one needs a pinned image.
 * @param {{build?: Record<string, any>}} easConfig
 * @param {readonly string[]} [allowedImages]
 * @returns {string[]} one message per problem; empty when every profile is pinned to an allowed image
 */
function findIosImageProblems(easConfig, allowedImages = ALLOWED_IOS_IMAGES) {
  const profiles = easConfig.build ?? {};
  const names = Object.keys(profiles);
  if (names.length === 0) return ['eas.json has no build profiles'];

  const problems = [];
  for (const name of names) {
    let image;
    try {
      image = resolveIosImage(profiles, name);
    } catch (error) {
      problems.push(error.message);
      continue;
    }
    if (image === undefined) {
      problems.push(`build profile "${name}" has no ios.image, so EAS picks its default image`);
    } else if (image === 'latest') {
      problems.push(`build profile "${name}" uses ios.image "latest", which EAS moves silently`);
    } else if (!allowedImages.includes(image)) {
      problems.push(
        `build profile "${name}" uses ios.image ${JSON.stringify(image)}, which is not in ` +
          `ALLOWED_IOS_IMAGES (${allowedImages.join(', ')})`,
      );
    }
  }
  return problems;
}

/** @returns {void} */
function main() {
  const easPath = path.resolve(__dirname, '..', 'eas.json');
  const problems = findIosImageProblems(JSON.parse(readFileSync(easPath, 'utf8')));
  if (problems.length > 0) {
    for (const problem of problems) console.error(`eas.json: ${problem}`);
    console.error(
      'Pin every build profile to an image in ALLOWED_IOS_IMAGES (scripts/check-eas-ios-images.js).',
    );
    process.exitCode = 1;
    return;
  }
  console.log('eas.json: every build profile pins an allowed iOS image.');
}

if (require.main === module) main();

module.exports = { ALLOWED_IOS_IMAGES, findIosImageProblems };
