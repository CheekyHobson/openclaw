import type { JSX } from "../../types/solid-elements.js";
import type { renderProviderIcon } from "./model-setup-icon-loader.tsx";
import type { createModelSetup, ModelSetupPageProps } from "./model-setup-owner.ts";

type ModelSetupOwnerView = ReturnType<ReturnType<typeof createModelSetup>["view"]>;
type ViewCallback<Value> = Value extends (...args: infer Args) => unknown
  ? (...args: Args) => void
  : Value;
type ViewData = {
  [Key in keyof ModelSetupOwnerView]: ViewCallback<ModelSetupOwnerView[Key]>;
};
type OptionalViewKeys =
  | Exclude<keyof ModelSetupPageProps, "routeData">
  | "detecting"
  | "connection"
  | "onManualInput"
  | "onFeedback"
  | "onWizardDialog"
  | "onDiscoveryShown"
  | "detectionError"
  | "modelConfigured"
  | "cancellationNotice"
  | "activationUnresolved"
  | "onUseCurrentModel"
  | "nativeSessionCatalogsEnabled"
  | "onNativeSessionCatalogsChange"
  | "nativeModels"
  | "onOpenSetupAssistant";

export type ModelSetupViewProps = Parameters<typeof renderProviderIcon>[0] &
  Omit<ViewData, OptionalViewKeys | "iconUrls" | "onIconError"> &
  Partial<Pick<ViewData, OptionalViewKeys>> & {
    login?: JSX.Element;
    revision?: () => unknown;
  };
