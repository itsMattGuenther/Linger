import { HEADINGS } from "../../core/settings";
import { ChoiceCards, Icon } from "../../kit";
import type { Live } from "./AppearanceSection";
import { Plain } from "./parts";

export type ConversationMode = "tabs" | "windows";
import type { CloseList } from "../../core/closing";

export type { CloseList };

export interface WindowsProps {
  /** How conversations open (WIN-2, WIN-3). Left out until there's a choice to make. */
  conversations?: Live<ConversationMode>;
  /** What closing the list does (WIN-7). Left out until there's a tray to keep running in. */
  closing?: Live<CloseList>;
}

/** Whether the Windows section has anything in it. */
export function hasWindowsChoices(props: WindowsProps | undefined): boolean {
  return props?.conversations !== undefined || props?.closing !== undefined;
}

/** Windows: how Linger sits on your desktop (docs/design/buddy-list.md, "Conversations beside the list"). */
export function WindowsSection({ conversations, closing }: WindowsProps) {
  return (
    <>
      {conversations ? (
        <Plain>
          <ChoiceCards
            legend={HEADINGS.conversations}
            name="conversations"
            value={conversations.value}
            onChange={conversations.onChange}
            choices={[
              {
                value: "tabs",
                title: "Beside your list, in one window",
                description: "Rooms and DMs open as tabs next to your list, and the whole thing moves as one window. Fold it back to just the list whenever you like, and pop a tab out when you want it somewhere else.",
                art: "beside",
              },
              {
                value: "windows",
                title: "Each in its own window",
                description: "Every room and DM gets a window of its own. Good on a tiling desktop, which lays them out for you.",
                art: "windows",
              },
            ]}
          />
          <p className="nx-set-callout">
            <Icon name="speaker" size="sm" />
            <span>Voice stays on when you switch tabs, fold your list or close a window. Mute, deafen and leave are in the voice bar at the bottom of your list.</span>
          </p>
        </Plain>
      ) : null}
      {closing ? (
        <Plain>
          <ChoiceCards
            legend={HEADINGS.closing}
            name="closing"
            value={closing.value}
            onChange={closing.onChange}
            choices={[
              { value: "tray", title: "Keep Linger running", description: "It tucks into the system tray: voice stays on, and knocks and mentions still reach you. Quit from the tray.", art: "moon" },
              { value: "quit", title: "Quit Linger", description: "Closing the list closes everything, and you're offline until you open it again.", art: "close" },
            ]}
          />
        </Plain>
      ) : null}
    </>
  );
}
