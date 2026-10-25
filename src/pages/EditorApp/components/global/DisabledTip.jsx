import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import styles from "../../styles/edit/_EditorNav.module.scss";

// Disabled buttons swallow hover, so the tooltip hangs off a wrapper span.
const DisabledTip = ({ content, active, children }) => (
  <Tooltip.Provider>
    <Tooltip.Root delayDuration={200} open={active ? undefined : false}>
      <Tooltip.Trigger asChild>
        <span className={styles.saveWrap}>{children}</span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className={styles.tooltip}
          side="bottom"
          align="end"
          sideOffset={8}
        >
          {content}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  </Tooltip.Provider>
);

export default DisabledTip;
