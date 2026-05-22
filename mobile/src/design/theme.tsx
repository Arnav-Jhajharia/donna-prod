import { createContext, useContext, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import { alpha, palette, radius, space } from "./primitives";
import { dark, light, type Roles } from "./roles";
import { tabular, type } from "./type";

export type ThemeMode = "light" | "dark";

export type Theme = {
  mode: ThemeMode;
  roles: Roles;
  type: typeof type;
  tabular: typeof tabular;
  space: typeof space;
  radius: typeof radius;
  palette: typeof palette;
  alpha: typeof alpha;
};

const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const mode: ThemeMode = scheme === "dark" ? "dark" : "light";
  const roles = mode === "dark" ? dark : light;

  const value: Theme = {
    mode,
    roles,
    type,
    tabular,
    space,
    radius,
    palette,
    alpha,
  };

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
