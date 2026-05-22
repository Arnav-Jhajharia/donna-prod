const apiUrl = process.env.EXPO_PUBLIC_DONNA_API_URL;
const userId = process.env.EXPO_PUBLIC_DONNA_USER_ID;

if (!apiUrl) throw new Error("EXPO_PUBLIC_DONNA_API_URL is required");

export const config = {
  apiUrl,
  userId: userId ?? null,
};
