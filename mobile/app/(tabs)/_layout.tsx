import { Tabs } from "expo-router";
import { TabBar } from "@/components/TabBar";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <TabBar {...props} />}
    >
      <Tabs.Screen name="dashboard" options={{ title: "dashboard" }} />
      <Tabs.Screen name="index" options={{ title: "live" }} />
      <Tabs.Screen name="history" options={{ title: "history" }} />
    </Tabs>
  );
}
