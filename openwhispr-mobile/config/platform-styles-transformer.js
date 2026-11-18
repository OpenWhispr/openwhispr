function transform(config, projectRoot, filename, data, options) {
  const { platformStyles, ...sharedConfig } = config;
  const selected = options.platform === 'ios' ? platformStyles.ios : platformStyles.default;
  const { transformerPath, ...styleConfig } = selected;
  return require(transformerPath).transform(
    { ...sharedConfig, ...styleConfig },
    projectRoot,
    filename,
    data,
    options,
  );
}

module.exports = { transform };
