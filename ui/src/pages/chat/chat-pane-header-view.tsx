import { onCleanup, untrack, type Element } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import type { PresentationValue } from "../../lib/presentation.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ElementProperties } from "../../types/solid-elements.d.ts";
import type { ChatMobileHost } from "./chat-mobile-host.ts";
import { usePanePresentation } from "./chat-pane-presentation.ts";
import type { ChatDetails } from "./components/chat-details.tsx";
import "./chat-pane-header-presence.css";

export type PaneDetailsProps = {
  chat: ChatDetails["props"];
  elements: ChatDetails["elements"];
  mobile: boolean;
  nativePresentation?: "desktop" | "mobile";
  mobileHost?: ChatMobileHost;
  mobileBindings?: ChatDetails["mobileBindings"];
  conversationVisible?: boolean;
  externalTrigger?: boolean;
  triggerContent?: Element;
  presentation: PresentationValue;
  setRef: (details: ChatDetails | undefined) => void;
};

export function PaneDetails(props: PaneDetailsProps) {
  const presented = usePanePresentation(() => props.presentation);
  onCleanup(() => untrack(() => props.setRef(undefined)));
  return (
    <openclaw-chat-details
      ref={(element) => untrack(() => props.setRef(element))}
      prop:props={props.chat}
      prop:elements={props.elements}
      prop:mobile={props.mobile}
      prop:nativePresentation={props.nativePresentation}
      prop:mobileHost={props.mobileHost}
      prop:mobileBindings={props.mobileBindings}
      prop:conversationVisible={props.conversationVisible ?? true}
      prop:externalTrigger={props.externalTrigger ?? false}
      prop:triggerContent={props.triggerContent}
      prop:presented={presented()}
    />
  );
}

type PresenceProps = Pick<
  HTMLElementTagNameMap["openclaw-viewer-facepile"],
  "staticUsers" | "personActivity"
>;

export function PaneSubagentStop(props: { onAbort: () => void; notice?: boolean }) {
  return (
    <button
      class={
        props.notice ? "btn btn--sm agent-chat__disabled-banner-stop" : "chat-subagent-detail__stop"
      }
      type="button"
      aria-label={t("chat.runControls.stopGenerating")}
      onClick={() => props.onAbort()}
    >
      <Icon name="stop" />
      <span>{t("chat.runControls.stop")}</span>
    </button>
  );
}
export function PaneHeaderPresence(props: PresenceProps) {
  return (
    <openclaw-viewer-facepile
      class="chat-pane__presence chat-pane__presence--desktop"
      prop:staticUsers={props.staticUsers}
      prop:maxVisible={3}
      prop:personActivity={props.personActivity}
      variant="session"
    />
  );
}


declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-details": HTMLAttributes<ChatDetails> &
        ElementProperties<
          Pick<
            ChatDetails,
            | "props"
            | "elements"
            | "presented"
            | "mobile"
            | "mobileHost"
            | "mobileBindings"
            | "nativePresentation"
            | "conversationVisible"
            | "externalTrigger"
            | "triggerContent"
          >
        >;
    }
  }
}
