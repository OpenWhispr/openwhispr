// SSR entry point for renderer-component structure tests. The dictation .tsx
// modules are compiled with the classic JSX runtime under the tsx loader, so
// they resolve React from the global scope instead of importing it.
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

globalThis.React = React;

const renderStatic = (type, props, ...children) =>
  renderToStaticMarkup(React.createElement(type, props, ...children));

module.exports = { React, renderStatic };
