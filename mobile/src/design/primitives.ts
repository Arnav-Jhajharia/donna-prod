/**
 * the "what it is" layer. mirrors `reference/tokens.css` lines 14-46,
 * 107-119, 166-174. do not import these in components — components
 * consume roles from `./roles.ts`. (rule R-C1 in reference/SYSTEM.md)
 *
 * if a value here changes, the dashboard's tokens.css changed first.
 * re-sync from there, never edit in isolation.
 */

export const palette = {
  // paper — warm off-white family
  paper: {
    50: "#FDFAF8",
    100: "#FBF7F5", // the page
    200: "#F5EFEA",
    300: "#F0EAE4", // resting surface
    400: "#E7DFD7", // pressed surface
    500: "#D6CAC0",
    600: "#B8A89B",
  },

  // ink — warm near-black family
  ink: {
    300: "#D9CEC5", // hairline on surface
    400: "#B5A89F", // placeholder, disabled
    500: "#8F837C", // tertiary type, meta
    600: "#6B615C", // secondary type
    800: "#3A3331",
    900: "#1E1A18", // primary type
  },

  // rust — brand accent family
  rust: {
    50: "#F5EFEA", // same hex as paper-200; named for rust-tint context
    100: "#EBDCD2",
    300: "#C9A796",
    500: "#A07562",
    700: "#7B5544", // accent
    900: "#4A2F23", // accent pressed / hover
  },

  // moss — success signal (reserved for states, never brand)
  moss: {
    100: "#EEF1E7",
    700: "#5C6B4A",
  },

  // amber — warning signal
  amber: {
    100: "#F5EBD9",
    700: "#A8804A",
  },

  // oxblood — danger signal
  oxblood: {
    100: "#F3E0DC",
    700: "#8B3A2E",
  },
} as const;

/**
 * hairlines, shadows, overlays on paper. ink-tinted, not pure black.
 * mirrors tokens.css §1 alpha block.
 */
export const alpha = {
  ink03: "rgba(30, 26, 24, 0.03)",
  ink04: "rgba(30, 26, 24, 0.04)",
  ink05: "rgba(30, 26, 24, 0.05)",
  ink08: "rgba(30, 26, 24, 0.08)",
  ink12: "rgba(30, 26, 24, 0.12)",
  ink14: "rgba(30, 26, 24, 0.14)",
  rust28: "rgba(123, 85, 68, 0.28)",
} as const;

/**
 * 4px base, ten named steps. only these values may appear in product code.
 * off-scale values (10, 14, 18, 20, 28, 40, 56, 80, 88) are off-system —
 * see SYSTEM.md §3 for the off-ramp table.
 */
export const space = {
  0: 0,
  px: 1,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 24,
  6: 32,
  7: 48,
  8: 64,
  9: 96,
  10: 128,
} as const;

/**
 * corner radii. 3px and 5px are explicitly removed (SYSTEM.md §11).
 */
export const radius = {
  0: 0,
  xs: 4, // chip inner stroke, small pressed
  sm: 6, // buttons, inputs
  md: 10, // cards, dialogs
  lg: 16, // large cards, modal
  xl: 24, // hero surfaces
  full: 999, // chips, dots, avatars
} as const;
