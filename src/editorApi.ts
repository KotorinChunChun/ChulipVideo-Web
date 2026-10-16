import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as desktop from "./tauriApi";
import * as browser from "./browser/api";
export type { ExportJob, ExportRequest, GlobalConfig, InputRecord, OverlaySettings, VideoMetadata, VideoSettings } from "./tauriApi";
export { siblingPath } from "./tauriApi";

export const browserMode = !isTauri();
export const loadGlobalConfig = browserMode ? browser.loadGlobalConfig : desktop.loadGlobalConfig;
export const saveGlobalConfig = browserMode ? browser.saveGlobalConfig : desktop.saveGlobalConfig;
export const loadVideoSettings = browserMode ? browser.loadVideoSettings : desktop.loadVideoSettings;
export const saveVideoSettings = browserMode ? browser.saveVideoSettings : desktop.saveVideoSettings;
export const openVideoDialog = browserMode ? browser.openVideoDialog : desktop.openVideoDialog;
export const probeVideo = browserMode ? browser.probeVideo : desktop.probeVideo;
export const extractPreview = browserMode ? browser.extractPreview : desktop.extractPreview;
export const loadInputHistory = browserMode ? browser.loadInputHistory : desktop.loadInputHistory;
export const pathExists = browserMode ? browser.pathExists : desktop.pathExists;
export const revealPath = browserMode ? browser.revealPath : desktop.revealPath;
export const startExportJob = browserMode ? browser.startExportJob : desktop.startExportJob;
export const cancelExportJob = browserMode ? browser.cancelExportJob : desktop.cancelExportJob;
export const listExportJobs = browserMode ? browser.listExportJobs : desktop.listExportJobs;
export const copyCurrentFrame = browserMode ? browser.copyCurrentFrame : desktop.copyCurrentFrame;
export const mediaUrl = (path: string) => browserMode ? browser.getVideoUrl(path) : convertFileSrc(path);
export const listenExportJobs = (handler: (job: desktop.ExportJob) => void): Promise<() => void> => browserMode
  ? Promise.resolve(browser.listenExportJobs(handler))
  : listen<desktop.ExportJob>("export-job://progress", (event) => handler(event.payload));
export const listenOpenVideo = (handler: (path: string) => void): Promise<() => void> => browserMode
  ? Promise.resolve(() => undefined)
  : listen<string>("editor://open-video", (event) => handler(event.payload));
