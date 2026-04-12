import React from "react";

const SettingsLayoutContext = React.createContext({ isCompact: false });

export const SettingsLayoutProvider = SettingsLayoutContext.Provider;

export const useSettingsLayout = () => React.useContext(SettingsLayoutContext);
