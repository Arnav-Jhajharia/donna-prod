import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/**
 * clerk's token cache, backed by ios keychain / android keystore via
 * expo-secure-store. clerk uses this to persist the session jwt across
 * app launches without it living in plaintext or asyncstorage.
 *
 * `getToken` returns null on cache miss. `saveToken` overwrites silently.
 * on web (which we don't ship to today but might) clerk falls back to its
 * own in-memory cache automatically when this returns undefined.
 */

export const tokenCache = {
  async getToken(key: string): Promise<string | null> {
    if (Platform.OS === "web") return null;
    try {
      const value = await SecureStore.getItemAsync(key);
      return value ?? null;
    } catch {
      return null;
    }
  },

  async saveToken(key: string, value: string): Promise<void> {
    if (Platform.OS === "web") return;
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      // silent — surfacing this to the user would be cargo-cult
    }
  },
};
