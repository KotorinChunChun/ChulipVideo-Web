import { invoke } from "@tauri-apps/api/core";

export type MockWindowKind =
  | "recorder"
  | "window-tool"
  | "app-settings"
  | "overlay-settings"
  | "shortcut-settings";

export async function openMockWindow(kind: MockWindowKind) {
  try {
    await invoke("open_mock_window", { kind });
  } catch (error) {
    console.warn("Tauri window command unavailable; using browser fallback.", error);
    window.open(
      `${window.location.origin}${window.location.pathname}?view=${kind}`,
      `chulip-${kind}`,
      "popup=yes,width=900,height=700",
    );
  }
}

export async function closeCurrentWindow() {
  try {
    await invoke("close_current_window");
  } catch (error) {
    console.warn("Tauri close command unavailable; using browser fallback.", error);
    window.close();
  }
}

export async function closeAndFocusMain() {
  try {
    await invoke("close_and_focus_main");
  } catch (error) {
    console.warn("Tauri focus command unavailable; using browser fallback.", error);
    window.close();
  }
}
