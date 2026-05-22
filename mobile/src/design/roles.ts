/**
 * the "what it does" layer. semantic roles that components consume.
 * mirrors `reference/tokens.css` lines 63-101 (light) and 225-238 (dark).
 *
 * components import `light` / `dark` (or read via the theme provider in
 * step 5). they never import from `./primitives.ts` directly. that
 * indirection is what makes dark mode and future re-skins free.
 */

import { alpha, palette } from "./primitives";

export type Roles = {
  bg: {
    canvas: string;
    surface: string;
    surfaceAlt: string;
    inset: string;
    inverse: string;
    accent: string;
    accentHover: string;
    accentTint: string;
    successTint: string;
    warningTint: string;
    dangerTint: string;
  };
  fg: {
    primary: string;
    secondary: string;
    tertiary: string;
    muted: string;
    placeholder: string;
    disabled: string;
    inverse: string;
    onRust: string;
    accent: string;
    accentStrong: string;
    success: string;
    warning: string;
    danger: string;
  };
  border: {
    hairline: string;
    strong: string;
    inset: string;
    accent: string;
    onSurface: string;
  };
};

export const light: Roles = {
  bg: {
    canvas: palette.paper[100],
    surface: palette.paper[300],
    surfaceAlt: palette.paper[400],
    inset: palette.paper[50],
    inverse: palette.ink[900],
    accent: palette.rust[700],
    accentHover: palette.rust[900],
    accentTint: palette.rust[50],
    successTint: palette.moss[100],
    warningTint: palette.amber[100],
    dangerTint: palette.oxblood[100],
  },
  fg: {
    primary: palette.ink[900],
    secondary: palette.ink[800],
    tertiary: palette.ink[600],
    muted: palette.ink[500],
    placeholder: palette.ink[400],
    disabled: palette.ink[400],
    inverse: palette.paper[100],
    onRust: palette.paper[100],
    accent: palette.rust[700],
    accentStrong: palette.rust[900],
    success: palette.moss[700],
    warning: palette.amber[700],
    danger: palette.oxblood[700],
  },
  border: {
    hairline: alpha.ink08,
    strong: alpha.ink14,
    inset: alpha.ink03,
    accent: alpha.rust28,
    onSurface: palette.ink[300],
  },
};

/**
 * dark overrides per tokens.css `.inverse` block (lines 225-238).
 * roles not overridden in that block inherit their light values —
 * i've made that inheritance explicit here so the object is complete.
 *
 * known tbd: signal tints (successTint/warningTint/dangerTint) and
 * accent bg roles (accent/accentHover/accentTint) inherit from light,
 * which renders as paper-toned bands on an ink canvas. the spec
 * doesn't override them; revisit once a real screen surfaces these.
 */
export const dark: Roles = {
  bg: {
    canvas: palette.ink[900],
    surface: palette.ink[800],
    surfaceAlt: palette.ink[800],
    inset: palette.ink[900],
    inverse: palette.paper[100],
    accent: palette.rust[700],
    accentHover: palette.rust[900],
    accentTint: palette.rust[50],
    successTint: palette.moss[100],
    warningTint: palette.amber[100],
    dangerTint: palette.oxblood[100],
  },
  fg: {
    primary: palette.paper[100],
    secondary: palette.paper[200],
    tertiary: palette.paper[300],
    muted: palette.rust[300],
    placeholder: palette.ink[500],
    disabled: palette.ink[500],
    inverse: palette.ink[900],
    onRust: palette.paper[100],
    accent: palette.rust[300],
    accentStrong: palette.rust[100],
    success: palette.moss[700],
    warning: palette.amber[700],
    danger: palette.oxblood[700],
  },
  border: {
    hairline: "rgba(251, 247, 245, 0.10)",
    strong: "rgba(251, 247, 245, 0.18)",
    inset: alpha.ink03,
    accent: alpha.rust28,
    onSurface: palette.ink[300],
  },
};
