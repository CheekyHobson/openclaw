import type { ChannelsPairingRequest } from "../../api/types.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import type { ChannelsPageProps } from "./channels-page.tsx";

export type ChannelSettingsPresentation = {
  has: (channelId: string) => boolean;
  sync: () => void;
  reset: () => void;
  attach: (channelId: string, container: HTMLElement) => () => void;
};

export type ChannelPairingPrompt = {
  kind: "approve" | "dismiss";
  request: ChannelsPairingRequest;
  notify: boolean;
  bootstrapCommandOwner: boolean;
};

export type ChannelsProps = {
  [Key in keyof Omit<ChannelsPageProps, "presentation">]: ChannelsPageProps[Key] extends (
    ...args: infer Args
  ) => unknown
    ? (...args: Args) => void
    : ChannelsPageProps[Key];
} & {
  presentation: {
    readonly pluginCatalog: PluginListResult | null;
    readonly pluginIconUrls: Record<string, string>;
    readonly details: ChannelSettingsPresentation;
  };
};
