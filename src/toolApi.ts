import { invoke } from "@tauri-apps/api/core";
import type { WindowGeometry, WindowTarget } from "./tauriApi";

export type AudioDevice = { id: string; name: string };

export const chooseDirectory = () => invoke<string | null>("choose_directory");
export const captureRegionPreview = (region: WindowGeometry) =>
  invoke<number[]>("capture_region_preview", { region });
export const renameRecording = (video: string, newName: string) =>
  invoke<string>("rename_recording", { video, newName });
export const trashRecording = (video: string) =>
  invoke<string[]>("trash_recording", { video });
export const listAudioDevices = () => invoke<AudioDevice[]>("list_audio_devices");

export async function startRecordingV3(options: {
  region: WindowGeometry;
  outputVideo: string;
  inputTsv: string | null;
  fps: number;
  quality: number;
  drawCursor: boolean;
  showRegion: boolean;
  maximumDurationSeconds: number | null;
  systemAudioEnabled: boolean;
  systemAudioDevice: string | null;
  microphoneEnabled: boolean;
  microphoneDevice: string | null;
  target: WindowTarget | null;
}) {
  const { target, region, ...recording } = options;
  return invoke<void>("start_recording", {
    command: {
      target,
      recording: {
        ...recording,
        region: {
          left: region.left,
          top: region.top,
          width: region.width,
          height: region.height,
        },
      },
    },
  });
}

export const closeAndEditRecording = (video: string) =>
  invoke<void>("close_and_focus_main", { video });
