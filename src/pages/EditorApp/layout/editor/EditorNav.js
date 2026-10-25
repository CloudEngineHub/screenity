import React, { useContext } from "react";
import DisabledTip from "../../components/global/DisabledTip";
import styles from "../../styles/edit/_EditorNav.module.scss";
import { ContentStateContext } from "../../context/ContentState";

const URL = "/assets/";

const EditorNav = () => {
  const [contentState, setContentState] = useContext(ContentStateContext);

  const handleCancel = () => {
    contentState.cancelEditOp();
    setContentState((prevContentState) => ({
      ...prevContentState,
      mode: "player",
      start: 0,
      end: 1,
    }));

    contentState.restoreBackup();
  };

  const handleRevert = () => {
    const prevBlob = contentState.blob;
    const prevStart = contentState.start;
    const prevEnd = contentState.end;
    setContentState((prevContentState) => ({
      ...prevContentState,
      blob: contentState.originalBlob,
      start: 0,
      end: 1,
    }));
    contentState.openToast?.(
      chrome.i18n.getMessage("sandboxToastReverted"),
      () => {
        setContentState((prev) => ({
          ...prev,
          blob: prevBlob,
          start: prevStart,
          end: prevEnd,
        }));
      },
    );
  };

  const hasPendingSelection =
    contentState.start !== 0 || contentState.end !== 1;

  const hasEdits =
    !contentState.backupBlob || contentState.blob !== contentState.backupBlob;

  const saveBlocked = hasPendingSelection && !contentState.isFfmpegRunning;

  const saveChanges = async () => {
    if (contentState.isFfmpegRunning || hasPendingSelection || !hasEdits) {
      return;
    }

    setContentState((prev) => ({
      ...prev,
      mode: "player",
      hasTempChanges: false,
      start: 0,
      end: 1,
    }));

    contentState.clearBackup();
    contentState.openToast?.(
      chrome.i18n.getMessage("sandboxToastSaved"),
      () => contentState.undo?.(),
    );
  };

  return (
    <div className={styles.editorNav}>
      <div className={styles.navWrap}>
        <div
          className={styles.editorNavLeft}
          onClick={() => {
            chrome.runtime.sendMessage({ type: "open-home" });
          }}
        >
          <img src={URL + "editor/logo.svg"} alt="Logo" />
        </div>
        <div className={styles.editorNavCenter}>
          <div className={styles.editorNavTitle}>
            {chrome.i18n.getMessage("sandboxEditorMainTitle")}{" "}
            <span className={styles.beta}>BETA</span>
          </div>
        </div>
        <div className={styles.editorNavRight}>
          <button
            className="button simpleButton blackButton"
            onClick={handleCancel}
          >
            {chrome.i18n.getMessage("sandboxEditorCancelButton")}
          </button>
          <button
            className="button secondaryButton"
            onClick={handleRevert}
            disabled={contentState.isFfmpegRunning}
          >
            {chrome.i18n.getMessage("sandboxEditorRevertButton")}
          </button>

          <DisabledTip
            active={saveBlocked}
            content={chrome.i18n.getMessage("sandboxEditorSelectionPendingHint")}
          >
            <button
              className="button primaryButton"
              onClick={saveChanges}
              disabled={
                contentState.isFfmpegRunning || hasPendingSelection || !hasEdits
              }
            >
              {contentState.reencoding
                ? chrome.i18n.getMessage("sandboxEditorSaveProgressButton")
                : chrome.i18n.getMessage("sandboxEditorSaveButton")}
            </button>
          </DisabledTip>
        </div>
      </div>
    </div>
  );
};

export default EditorNav;
