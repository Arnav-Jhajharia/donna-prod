/**
 * typography roles. mirrors `reference/SYSTEM.md` §2 (the role table)
 * and `reference/tokens.css` lines 122-163.
 *
 * each role is a `TextStyle` you spread onto a `<Text>`:
 *     <Text style={type.body}>...
 *
 * css→rn translation notes:
 * - `lineHeight` in css is a multiplier; rn expects absolute px.
 *   precomputed and rounded to integer (sub-pixel lh is invisible).
 * - `letterSpacing` in css is em; rn expects absolute px.
 *   precomputed: em * fontSize, rounded to 2dp.
 * - `font-weight` is encoded into the `fontFamily` name itself
 *   (e.g. `RedHatText_500Medium`) because android often drops
 *   numeric `fontWeight` when `fontFamily` is custom.
 * - italic is not used by any role here. emphasis inside prose is a
 *   component concern (a future <Em> wrapper). the wordmark is its
 *   own component, not a type role.
 */

import type { TextStyle } from "react-native";

/**
 * font family names as we will register them with expo-font in step 5.
 * exported for the font loader's use only. components must read from
 * the `type` roles below.
 */
export const family = {
  serifRegular: "EBGaramond_400Regular",
  serifMedium: "EBGaramond_500Medium",
  sansRegular: "RedHatText_400Regular",
  sansMedium: "RedHatText_500Medium",
  sansSemi: "RedHatText_600SemiBold",
} as const;

export const type = {
  // serif, upright. SYSTEM.md §2 — upright before italic (R-T1).
  display: {
    fontFamily: family.serifRegular,
    fontSize: 72,
    lineHeight: 73,
    letterSpacing: -1.8,
  },
  h1: {
    fontFamily: family.serifRegular,
    fontSize: 56,
    lineHeight: 62,
    letterSpacing: -1.12,
  },
  h2: {
    fontFamily: family.serifRegular,
    fontSize: 36,
    lineHeight: 40,
    letterSpacing: -0.54,
  },
  h3: {
    fontFamily: family.serifMedium,
    fontSize: 22,
    lineHeight: 27,
    letterSpacing: -0.22,
  },

  // sans. utility voice. card titles are sans 600 (resolves AUDIT 8.2).
  h4Card: {
    fontFamily: family.sansSemi,
    fontSize: 15,
    lineHeight: 19,
    letterSpacing: 0,
  },
  lead: {
    fontFamily: family.sansRegular,
    fontSize: 17,
    lineHeight: 27,
    letterSpacing: 0,
  },
  body: {
    fontFamily: family.sansRegular,
    fontSize: 16,
    lineHeight: 26,
    letterSpacing: 0,
  },
  small: {
    fontFamily: family.sansRegular,
    fontSize: 14,
    lineHeight: 21,
    letterSpacing: 0,
  },
  caption: {
    fontFamily: family.sansRegular,
    fontSize: 13,
    lineHeight: 20,
    letterSpacing: 0,
  },
  eyebrow: {
    fontFamily: family.sansMedium,
    fontSize: 11,
    lineHeight: 11,
    letterSpacing: 1.54,
    textTransform: "uppercase",
  },
  button: {
    fontFamily: family.sansMedium,
    fontSize: 15,
    lineHeight: 15,
    letterSpacing: 0,
  },
} satisfies Record<string, TextStyle>;

/**
 * R-T5 — any digit stack uses tabular numerals. compose with a role:
 *     <Text style={[type.body, tabular]}>$24.00</Text>
 */
export const tabular: TextStyle = {
  fontVariant: ["tabular-nums"],
};
