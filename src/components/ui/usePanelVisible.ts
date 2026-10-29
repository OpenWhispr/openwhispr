import React from "react";

// False inside a TabPanel that is mounted but hidden; anything outside a TabPanel is shown.
const PanelVisibleContext = React.createContext(true);

export const PanelVisibleProvider = PanelVisibleContext.Provider;

export const usePanelVisible = () => React.useContext(PanelVisibleContext);
