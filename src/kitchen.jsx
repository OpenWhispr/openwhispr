import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import i18n from "./i18n";
import Kitchen from "./dev/Kitchen.tsx";
import DevTools from "./dev/DevTools.tsx";

// Same two stylesheet imports as main.jsx, in the same order, so the gallery
// resolves identical tokens and fonts to the real app.
import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/caveat";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}>
      <Kitchen />
      {/* The DialKit panel works here too, so the design dials tune the gallery. */}
      <DevTools />
    </I18nextProvider>
  </React.StrictMode>
);
