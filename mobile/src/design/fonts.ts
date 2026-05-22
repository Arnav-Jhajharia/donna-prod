import { useFonts } from "expo-font";
import {
  EBGaramond_400Regular,
  EBGaramond_500Medium,
} from "@expo-google-fonts/eb-garamond";
import {
  RedHatText_400Regular,
  RedHatText_500Medium,
  RedHatText_600SemiBold,
} from "@expo-google-fonts/red-hat-text";

/**
 * loads the five font variants the design system uses.
 * returns `true` once all are ready; render a splash until then.
 *
 * the keys here must match the `family.*` strings in `./type.ts` — that's
 * what makes `fontFamily: "EBGaramond_400Regular"` actually resolve.
 */
export function useDonnaFonts() {
  const [loaded] = useFonts({
    EBGaramond_400Regular,
    EBGaramond_500Medium,
    RedHatText_400Regular,
    RedHatText_500Medium,
    RedHatText_600SemiBold,
  });
  return loaded;
}
